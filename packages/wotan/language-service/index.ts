import * as ts from 'typescript';
import {
    FileSystem,
    MessageHandler,
    Finding,
    FileFilterFactory,
    DirectoryService,
    Resolver,
    GlobalOptions,
    StaticProgramState,
    StatePersistence,
    ContentId,
    CodeAction,
} from '@fimbul/ymir';
import { Container, BindingScopeEnum, ContainerModule } from 'inversify';
import { createCoreModule } from '../src/di/core.module';
import { createDefaultModule } from '../src/di/default.module';
import { ConfigurationManager } from '../src/services/configuration-manager';
import { Linter, LinterOptions } from '../src/linter';
import { addUnique, emptyArray, mapDefined } from '../src/utils';
import { CachedFileSystem } from '../src/services/cached-file-system';
import * as resolve from 'resolve';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { parseGlobalOptions, ParsedGlobalOptions } from '../src/argparse';
import { normalizeGlob } from 'normalize-glob';
import { Minimatch } from 'minimatch';
import { ProgramStateFactory } from '../src/services/program-state';
import { createConfigHash } from '../src/config-hash';
import { getLineBreakStyle } from 'tsutils';
import { applyFixes } from '../src/fix';

export const version = '2';
const DIAGNOSTIC_CODE = 3;

export class LanguageServiceInterceptor implements Partial<ts.LanguageService> {
    private lastProjectVersion = '';
    private findingsForFile = new WeakMap<ts.SourceFile, readonly Finding[]>();
    private oldState: StaticProgramState | undefined = undefined;
    public getExternalFiles?: () => string[]; // can be implemented later

    constructor(
        protected config: Record<string, unknown>,
        // tslint:disable:no-submodule-imports
        protected project: import('typescript/lib/tsserverlibrary').server.Project,
        protected serverHost: import('typescript/lib/tsserverlibrary').server.ServerHost,
        // tslint:enable:no-submodule-imports
        protected languageService: ts.LanguageService,
        protected require: (id: string) => {},
        protected log: (message: string) => void,
    ) {}

    public updateConfig(config: Record<string, unknown>) {
        this.config = config;
    }

    public getSemanticDiagnostics(fileName: string): ts.Diagnostic[] {
        const diagnostics = this.languageService.getSemanticDiagnostics(fileName);
        this.log(`getSemanticDiagnostics for ${fileName}`);
        const result = this.getFindingsForFile(fileName);
        if (!result?.findings.length)
            return diagnostics;
        const findingDiagnostics = mapDefined(result.findings, (finding) => finding.severity === 'suggestion'
            ? undefined
            : {
                file: result.file,
                category: this.config.displayErrorsAsWarnings || finding.severity === 'warning'
                    ? ts.DiagnosticCategory.Warning
                    : ts.DiagnosticCategory.Error,
                code: DIAGNOSTIC_CODE,
                source: 'wotan',
                messageText: `[${finding.ruleName}] ${finding.message}`,
                start: finding.start.position,
                length: finding.end.position - finding.start.position,
            },
        );
        return [...diagnostics, ...findingDiagnostics];
    }

    public getSuggestionDiagnostics(fileName: string): ts.DiagnosticWithLocation[] {
        const diagnostics = this.languageService.getSuggestionDiagnostics(fileName);
        this.log(`getSuggestionDiagnostics for ${fileName}`);
        const result = this.getFindingsForFile(fileName);
        if (!result?.findings.length)
            return diagnostics;
        const findingDiagnostics = mapDefined(result.findings, (finding) => finding.severity !== 'suggestion'
            ? undefined
            : {
                file: result.file,
                category: ts.DiagnosticCategory.Suggestion,
                code: DIAGNOSTIC_CODE,
                source: 'wotan',
                messageText: `[${finding.ruleName}] ${finding.message}`,
                start: finding.start.position,
                length: finding.end.position - finding.start.position,
            },
        );
        return [...diagnostics, ...findingDiagnostics];
    }

    public getCodeFixesAtPosition(
        fileName: string,
        start: number,
        end: number,
        errorCodes: readonly number[],
        formatOptions: ts.FormatCodeSettings,
        preferences: ts.UserPreferences,
    ): readonly ts.CodeFixAction[] {
        const fixes = this.languageService.getCodeFixesAtPosition(fileName, start, end, errorCodes, formatOptions, preferences);
        if (!errorCodes.includes(DIAGNOSTIC_CODE))
            return fixes;
        this.log(`getCodeFixesAtPosition for ${fileName} from ${start} to ${end}`);
        const result = this.getFindingsForFile(fileName);
        if (!result)
            return fixes;
        const ruleFixes: ts.CodeFixAction[] = [];
        const disables: ts.CodeFixAction[] = [];
        let fixableFindings: readonly Finding[] | undefined;
        for (const finding of result.findings) {
            if (finding.start.position === start && finding.end.position === end) {
                if (finding.fix !== undefined) {
                    fixableFindings ??= result.findings.filter((f) => f.fix !== undefined);
                    const multipleFixableFindingsForRule = fixableFindings.some((f) => f.ruleName === finding.ruleName && f !== finding);
                    ruleFixes.push(codeActionToCodeFix(fileName, finding.ruleName, finding.fix, multipleFixableFindingsForRule));
                }

                if (finding.codeActions)
                    for (const action of finding.codeActions)
                        ruleFixes.push(codeActionToCodeFix(fileName, finding.ruleName, action));

                disables.push({
                    fixName: 'disable ' + finding.ruleName,
                    description: `Disable ${finding.ruleName} for this line`,
                    changes: [{
                        fileName,
                        textChanges: [
                            getDisableCommentChange(finding.start.position, result.file, finding.ruleName, formatOptions.newLineCharacter),
                        ],
                    }],
                });
            }
        }

        if (fixableFindings !== undefined && fixableFindings.length > 1) {
            try {
                const fixAll = applyFixes(result.file.text, fixableFindings.map((f) => f.fix!));
                if (fixAll.fixed > 1)
                    ruleFixes.push({
                        fixName: 'wotan:fixall',
                        description: 'Apply all auto-fixes',
                        changes: [{
                            fileName,
                            textChanges: [{
                                span: fixAll.range.span,
                                newText: fixAll.result.substr(fixAll.range.span.start, fixAll.range.newLength),
                            }],
                        }],
                    });
            } catch (e) {
                this.log('Error in fixAll: ' + e?.message);
            }
        }

        return [...fixes, ...ruleFixes, ...disables];
    }

    public getCombinedCodeFix(
        scope: ts.CombinedCodeFixScope,
        fixId: {},
        formatOptions: ts.FormatCodeSettings,
        preferences: ts.UserPreferences,
    ): ts.CombinedCodeActions {
        if (typeof fixId !== 'string' || !fixId.startsWith('wotan:'))
            return this.languageService.getCombinedCodeFix(scope, fixId, formatOptions, preferences);
        const findingsForFile = this.getFindingsForFile(scope.fileName)!;
        const ruleName = fixId.substring('wotan:'.length);
        const fixAll = applyFixes(
            findingsForFile.file.text,
            mapDefined(findingsForFile.findings, (f) => f.ruleName === ruleName ? f.fix : undefined),
        );
        return {
            changes: [{
                fileName: scope.fileName,
                textChanges: [{
                    span: fixAll.range.span,
                    newText: fixAll.result.substr(fixAll.range.span.start, fixAll.range.newLength),
                }],
            }],
        };
    }

    private getFindingsForFile(fileName: string) {
        const program = this.languageService.getProgram();
        if (program === undefined)
            return;
        const file = program.getSourceFile(fileName);
        if (file === undefined) {
            this.log(`File ${fileName} is not included in the Program`);
            return;
        }
        const projectVersion = this.project.getProjectVersion();
        if (this.lastProjectVersion === projectVersion) {
            const cached = this.findingsForFile.get(file);
            if (cached !== undefined) {
                this.log(`Reusing last result with ${cached.length} findings`);
                return {file, findings: cached};
            }
        } else {
            this.findingsForFile = new WeakMap();
            this.lastProjectVersion = projectVersion;
        }
        try {
            const findings = this.getFindingsForFileWorker(file, program);
            this.findingsForFile.set(file, findings);
            return {file, findings};
        } catch (e) {
            this.log(`Error linting ${fileName}: ${e?.message}`);
            this.findingsForFile.set(file, emptyArray);
            return;
        }
    }

    private getFindingsForFileWorker(file: ts.SourceFile, program: ts.Program) {
        let globalConfigDir = this.project.getCurrentDirectory();
        let globalOptions: any;
        while (true) {
            const scriptSnapshot = this.project.getScriptSnapshot(globalConfigDir + '/.fimbullinter.yaml');
            if (scriptSnapshot !== undefined) {
                this.log(`Using '${globalConfigDir}/.fimbullinter.yaml' for global options`);
                globalOptions = yaml.load(scriptSnapshot.getText(0, scriptSnapshot.getLength())) || {};
                break;
            }
            const parentDir = path.dirname(globalConfigDir);
            if (parentDir === globalConfigDir) {
                this.log("Cannot find '.fimbullinter.yaml'");
                globalOptions = {};
                break;
            }
            globalConfigDir = parentDir;
        }
        const globalConfig = parseGlobalOptions(globalOptions);
        if (!isIncluded(file.fileName, globalConfigDir, globalConfig)) {
            this.log('File is excluded by global options');
            return [];
        }
        const container = new Container({defaultScope: BindingScopeEnum.Singleton});
        for (const module of globalConfig.modules)
            container.load(this.loadPluginModule(module, globalConfigDir, globalOptions));

        container.bind(StatePersistence).toConstantValue({
            loadState: () => this.oldState,
            saveState: (_, state) => this.oldState = state,
        });
        container.bind(ContentId).toConstantValue({
            forFile: (fileName) => this.project.getScriptVersion(fileName),
        });
        container.bind(FileSystem).toConstantValue(new ProjectFileSystem(this.project));
        container.bind(DirectoryService).toConstantValue({
            getCurrentDirectory: () => this.project.getCurrentDirectory(),
        });
        container.bind(Resolver).toDynamicValue((context) => {
            const fs = context.container.get(CachedFileSystem);
            return {
                getDefaultExtensions() {
                    return ['.js'];
                },
                resolve(id, basedir, extensions = ['.js'], paths) {
                    return resolve.sync(id, {
                        basedir,
                        extensions,
                        paths,
                        isFile: (f) => fs.isFile(f),
                        readFileSync: (f) => fs.readFile(f),
                    });
                },
                require: this.require,
            };
        });
        const warnings: string[] = [];
        container.bind(MessageHandler).toConstantValue({
            log: this.log,
            warn: (message) => {
                if (addUnique(warnings, message))
                    this.log(message);
            },
            error(e) {
                this.log(e.message);
            },
        });
        container.load(createCoreModule(globalOptions), createDefaultModule());
        const fileFilter = container.get(FileFilterFactory).create({program, host: this.project});
        if (!fileFilter.filter(file)) {
            this.log('File is excluded by FileFilter');
            return [];
        }
        const configManager = container.get(ConfigurationManager);
        const config = globalConfig.config === undefined
            ? configManager.find(file.fileName)
            : configManager.loadLocalOrResolved(globalConfig.config, globalConfigDir);
        const effectiveConfig = config && configManager.reduce(config, file.fileName);
        if (effectiveConfig === undefined) {
            this.log('File is excluded by configuration');
            return [];
        }

        const linterOptions: LinterOptions = {
            reportUselessDirectives: globalConfig.reportUselessDirectives
                ? globalConfig.reportUselessDirectives === true
                    ? 'error'
                    : globalConfig.reportUselessDirectives
                : undefined,
        };
        const programState = container.get(ProgramStateFactory).create(program, this.project, this.project.projectName);
        const configHash = createConfigHash(effectiveConfig, linterOptions);
        const cached = programState.getUpToDateResult(file.fileName, configHash);
        if (cached !== undefined) {
            this.log(`Using ${cached.length} cached findings`);
            return cached;
        }

        this.log('Start linting');
        const linter = container.get(Linter);
        const result = linter.lintFile(file, effectiveConfig, program, linterOptions);
        programState.setFileResult(file.fileName, configHash, result);
        programState.save();
        this.log(`Found ${result.length} findings`);
        return result;
    }

    private loadPluginModule(moduleName: string, basedir: string, options: GlobalOptions) {
        moduleName = resolve.sync(moduleName, {
            basedir,
            extensions: ['.js'],
            isFile: (f) => this.project.fileExists(f),
            readFileSync: (f) => this.project.readFile(f)!,
        });
        const m = <{createModule?(options: GlobalOptions): ContainerModule} | null | undefined>this.require(moduleName);
        if (!m || typeof m.createModule !== 'function')
            throw new Error(`Module '${moduleName}' does not export a function 'createModule'`);
        return m.createModule(options);
    }

    public getSupportedCodeFixes(fixes: string[]) {
        return [...fixes, '' + DIAGNOSTIC_CODE];
    }

    public cleanupSemanticCache() {
        this.findingsForFile = new WeakMap();
        this.oldState = undefined;
    }

    public dispose() {
        return this.languageService.dispose();
    }
}

function isIncluded(fileName: string, basedir: string, options: ParsedGlobalOptions): boolean {
    outer: if (options.files.length !== 0) {
        for (const include of options.files)
            for (const normalized of normalizeGlob(include, basedir))
                if (new Minimatch(normalized).match(fileName))
                    break outer;
        return false;
    }

    for (const exclude of options.exclude)
        for (const normalized of normalizeGlob(exclude, basedir))
            if (new Minimatch(normalized, {dot: true}).match(fileName))
                return false;
    return true;
}

class ProjectFileSystem implements FileSystem {
    public realpath = this.host.realpath && ((f: string) => this.host.realpath!(f));
    constructor(
        private host: Required<
            Pick<
                ts.LanguageServiceHost,
                'useCaseSensitiveFileNames' | 'readFile' | 'readDirectory' | 'fileExists' | 'directoryExists'
            >
        > & Pick<ts.LanguageServiceHost, 'realpath'>,
    ) {}
    public createDirectory() {
        throw new Error('should not be called');
    }
    public deleteFile() {
        throw new Error('should not be called');
    }
    public writeFile() {
        throw new Error('should not be called');
    }
    public normalizePath(f: string) {
        f = f.replace(/\\/g, '/');
        return this.host.useCaseSensitiveFileNames() ? f : f.toLowerCase();
    }
    public readFile(f: string) {
        const result = this.host.readFile(f);
        if (result === undefined)
            throw new Error('ENOENT');
        return result;
    }
    public readDirectory(dir: string) {
        return this.host.readDirectory(dir, undefined, undefined, ['*']);
    }
    public stat(f: string) {
        const isFile = this.host.fileExists(f)
            ? true
            : this.host.directoryExists(f)
                ? false
                : undefined;
        return {
            isDirectory() {
                return isFile === false;
            },
            isFile() {
                return isFile === true;
            },
        };
    }
}

function codeActionToCodeFix(fileName: string, ruleName: string, action: CodeAction, fixAll?: boolean): ts.CodeFixAction {
    return {
        fixName: `wotan:${ruleName}:${action.description}`,
        description: `[${ruleName}] ${action.description}`,
        fixId: fixAll ? 'wotan:' + ruleName : undefined,
        fixAllDescription: fixAll ? 'Fix all ' + ruleName : undefined,
        changes: [{
            fileName,
            textChanges:
                action.replacements.map((r) => ({span: {start: r.start, length: r.end - r.start}, newText: r.text})),
        }],
    };
}

// TODO this should be done by Linter or FindingFilter
function getDisableCommentChange(
    pos: number,
    sourceFile: ts.SourceFile,
    ruleName: string,
    newline: string = getLineBreakStyle(sourceFile),
): ts.TextChange {
    const lineStart = pos - ts.getLineAndCharacterOfPosition(sourceFile, pos).character;
    let whitespace = '';
    for (let i = lineStart, ch: number; i < sourceFile.text.length; i += charSize(ch)) {
        ch = sourceFile.text.codePointAt(i)!;
        if (ts.isWhiteSpaceSingleLine(ch)) {
            whitespace += String.fromCodePoint(ch);
        } else {
            break;
        }
    }
    return {
        newText: `${whitespace}// wotan-disable-next-line ${ruleName}${newline}`,
        span: {
            start: lineStart,
            length: 0,
        },
    };
}

function charSize(ch: number) {
    return ch >= 0x10000 ? 2 : 1;
}
