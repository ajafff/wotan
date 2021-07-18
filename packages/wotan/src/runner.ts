import { Linter, LinterOptions, ProgramFactory } from './linter';
import {
    LintResult,
    FileSummary,
    Configuration,
    AbstractProcessor,
    DirectoryService,
    ConfigurationError,
    MessageHandler,
    FileFilterFactory,
    Severity,
} from '@fimbul/ymir';
import * as path from 'path';
import * as ts from 'typescript';
import * as glob from 'glob';
import { unixifyPath, hasSupportedExtension, addUnique, flatMap, hasParseErrors, invertChangeRange } from './utils';
import { Minimatch, IMinimatch } from 'minimatch';
import { ProcessorLoader } from './services/processor-loader';
import { injectable } from 'inversify';
import { CachedFileSystem, FileKind } from './services/cached-file-system';
import { ConfigurationManager } from './services/configuration-manager';
import { ProjectHost } from './project-host';
import debug = require('debug');
import { normalizeGlob } from 'normalize-glob';
import { ProgramStateFactory } from './services/program-state';
import { createConfigHash } from './config-hash';

const log = debug('wotan:runner');

export interface LintOptions {
    config: string | undefined;
    files: ReadonlyArray<string>;
    exclude: ReadonlyArray<string>;
    project: ReadonlyArray<string>;
    references: boolean;
    fix: boolean | number;
    extensions: ReadonlyArray<string> | undefined;
    reportUselessDirectives: Severity | boolean | undefined;
    cache: boolean;
}

interface NormalizedOptions extends Pick<LintOptions, Exclude<keyof LintOptions, 'files'>> {
    files: ReadonlyArray<NormalizedGlob>;
}

interface NormalizedGlob {
    hasMagic: boolean;
    normalized: string[];
}

@injectable()
export class Runner {
    constructor(
        private fs: CachedFileSystem,
        private configManager: ConfigurationManager,
        private linter: Linter,
        private processorLoader: ProcessorLoader,
        private directories: DirectoryService,
        private logger: MessageHandler,
        private filterFactory: FileFilterFactory,
        private programStateFactory: ProgramStateFactory,
    ) {}

    public lintCollection(options: LintOptions): LintResult {
        const config = options.config !== undefined ? this.configManager.loadLocalOrResolved(options.config) : undefined;
        const cwd = this.directories.getCurrentDirectory();
        const files = options.files.map(
            (pattern) => ({hasMagic: glob.hasMagic(pattern), normalized: Array.from(normalizeGlob(pattern, cwd))}),
        );
        const exclude = flatMap(options.exclude, (pattern) => normalizeGlob(pattern, cwd));
        const linterOptions: LinterOptions = {
            reportUselessDirectives: options.reportUselessDirectives
                ? options.reportUselessDirectives === true
                    ? 'error'
                    : options.reportUselessDirectives
                : undefined,
        };
        if (options.project.length === 0 && options.files.length !== 0)
            return this.lintFiles({...options, files, exclude}, config, linterOptions);

        return this.lintProject({...options, files, exclude}, config, linterOptions);
    }

    private *lintProject(options: NormalizedOptions, config: Configuration | undefined, linterOptions: LinterOptions): LintResult {
        const processorHost = new ProjectHost(
            this.directories.getCurrentDirectory(),
            config,
            this.fs,
            this.configManager,
            this.processorLoader,
        );
        for (let {files, program, configFilePath: tsconfigPath} of
            this.getFilesAndProgram(options.project, options.files, options.exclude, processorHost, options.references)
        ) {
            const programState = options.cache ? this.programStateFactory.create(program, processorHost, tsconfigPath) : undefined;
            let invalidatedProgram = false;
            const factory: ProgramFactory = {
                getCompilerOptions() {
                    return program.getCompilerOptions();
                },
                getProgram() {
                    if (invalidatedProgram) {
                        log('updating invalidated program');
                        program = processorHost.updateProgram(program);
                        invalidatedProgram = false;
                    }
                    return program;
                },
            };
            for (const file of files) {
                if (options.config === undefined)
                    config = this.configManager.find(file);
                const mapped = processorHost.getProcessedFileInfo(file);
                const originalName = mapped === undefined ? file : mapped.originalName;
                const effectiveConfig = config && this.configManager.reduce(config, originalName);
                if (effectiveConfig === undefined)
                    continue;
                let sourceFile = program.getSourceFile(file)!;
                const originalContent = mapped === undefined ? sourceFile.text : mapped.originalContent;
                let summary: FileSummary;
                const fix = shouldFix(sourceFile, options, originalName);
                const configHash = programState === undefined ? undefined : createConfigHash(effectiveConfig, linterOptions);
                const resultFromCache = programState?.getUpToDateResult(sourceFile.fileName, configHash!);
                if (fix) {
                    let updatedFile = false;
                    summary = this.linter.lintAndFix(
                        sourceFile,
                        originalContent,
                        effectiveConfig,
                        (content, range) => {
                            invalidatedProgram = true;
                            const oldContent = sourceFile.text;
                            sourceFile = ts.updateSourceFile(sourceFile, content, range);
                            const hasErrors = hasParseErrors(sourceFile);
                            if (hasErrors) {
                                log("Autofixing caused syntax errors in '%s', rolling back", sourceFile.fileName);
                                sourceFile = ts.updateSourceFile(sourceFile, oldContent, invertChangeRange(range));
                            } else {
                                updatedFile = true;
                            }
                            // either way we need to store the new SourceFile as the old one is now corrupted
                            processorHost.updateSourceFile(sourceFile);
                            return hasErrors ? undefined : sourceFile;
                        },
                        fix === true ? undefined : fix,
                        factory,
                        mapped?.processor,
                        linterOptions,
                        // pass cached results so we can apply fixes from cache
                        resultFromCache,
                    );
                    if (updatedFile)
                        programState?.update(factory.getProgram(), sourceFile.fileName);
                } else {
                    summary = {
                        findings: resultFromCache ?? this.linter.getFindings(
                            sourceFile,
                            effectiveConfig,
                            factory,
                            mapped?.processor,
                            linterOptions,
                        ),
                        fixes: 0,
                        content: originalContent,
                    };
                }
                if (programState !== undefined && resultFromCache !== summary.findings)
                    programState.setFileResult(file, configHash!, summary.findings);
                yield [originalName, summary];
            }
            programState?.save();
        }
    }

    private *lintFiles(options: NormalizedOptions, config: Configuration | undefined, linterOptions: LinterOptions): LintResult {
        let processor: AbstractProcessor | undefined;
        for (const file of getFiles(options.files, options.exclude, this.directories.getCurrentDirectory())) {
            if (options.config === undefined)
                config = this.configManager.find(file);
            const effectiveConfig = config && this.configManager.reduce(config, file);
            if (effectiveConfig === undefined)
                continue;
            let originalContent: string | undefined;
            let name: string;
            let content: string;
            if (effectiveConfig.processor) {
                const ctor = this.processorLoader.loadProcessor(effectiveConfig.processor);
                if (hasSupportedExtension(file, options.extensions)) {
                    name = file;
                } else {
                    name = file + ctor.getSuffixForFile({
                        fileName: file,
                        getSettings: () => effectiveConfig.settings,
                        readFile: () => originalContent = this.fs.readFile(file),
                    });
                    if (!hasSupportedExtension(name, options.extensions))
                        continue;
                }
                if (originalContent === undefined) // might be initialized by the processor requesting the file content
                    originalContent = this.fs.readFile(file);
                processor = new ctor({
                    source: originalContent,
                    sourceFileName: file,
                    targetFileName: name,
                    settings: effectiveConfig.settings,
                });
                content = processor.preprocess();
            } else if (hasSupportedExtension(file, options.extensions)) {
                processor = undefined;
                name = file;
                content = originalContent = this.fs.readFile(file);
            } else {
                continue;
            }

            let sourceFile = ts.createSourceFile(name, content, ts.ScriptTarget.ESNext, true);
            const fix = shouldFix(sourceFile, options, file);
            let summary: FileSummary;
            if (fix) {
                summary = this.linter.lintAndFix(
                    sourceFile,
                    originalContent,
                    effectiveConfig,
                    (newContent, range) => {
                        sourceFile = ts.updateSourceFile(sourceFile, newContent, range);
                        if (hasParseErrors(sourceFile)) {
                            log("Autofixing caused syntax errors in '%s', rolling back", sourceFile.fileName);
                            // Note: 'sourceFile' shouldn't be used after this as it contains invalid code
                            return;
                        }
                        return sourceFile;
                    },
                    fix === true ? undefined : fix,
                    undefined,
                    processor,
                    linterOptions,
                );
            } else {
                summary = {
                    findings: this.linter.getFindings(
                        sourceFile,
                        effectiveConfig,
                        undefined,
                        processor,
                        linterOptions,
                    ),
                    fixes: 0,
                    content: originalContent,
                };
            }
            yield [file, summary];
        }
    }

    private* getFilesAndProgram(
        projects: ReadonlyArray<string>,
        patterns: ReadonlyArray<NormalizedGlob>,
        exclude: ReadonlyArray<string>,
        host: ProjectHost,
        references: boolean,
    ): Iterable<{files: Iterable<string>, program: ts.Program, configFilePath: string}> {
        const cwd = unixifyPath(this.directories.getCurrentDirectory());
        if (projects.length !== 0) {
            projects = this.matchProjectGlobs(projects);
        } else if (references) {
            projects = [this.checkConfigDirectory(cwd)];
        } else {
            const project = ts.findConfigFile(cwd, (f) => this.fs.isFile(f));
            if (project === undefined)
                throw new ConfigurationError(`Cannot find tsconfig.json for directory '${cwd}'.`);
            projects = [project];
        }

        const allMatchedFiles: string [] = [];
        const include: IMinimatch[] = [];
        const nonMagicGlobs: NonMagicGlob[] = [];
        for (const pattern of patterns) {
            if (!pattern.hasMagic) {
                const mm = new Minimatch(pattern.normalized[0]);
                nonMagicGlobs.push({raw: pattern.normalized[0], match: mm});
                include.push(mm);
            } else {
                include.push(...pattern.normalized.map((p) => new Minimatch(p)));
            }
        }
        const ex = exclude.map((p) => new Minimatch(p, {dot: true}));
        const projectsSeen: string[] = [];
        let filesOfPreviousProject: string[] | undefined;
        for (const {program, configFilePath} of this.createPrograms(projects, host, projectsSeen, references, isFileIncluded)) {
            const ownFiles = [];
            const files: string[] = [];
            const fileFilter = this.filterFactory.create({program, host});

            for (const sourceFile of program.getSourceFiles()) {
                if (!fileFilter.filter(sourceFile))
                    continue;
                const {fileName} = sourceFile;
                ownFiles.push(fileName);
                const originalName = host.getFileSystemFile(fileName)!;
                if (!isFileIncluded(originalName))
                    continue;
                files.push(fileName);
                allMatchedFiles.push(originalName);
            }
            // uncache all files of the previous project if they are no longer needed
            if (filesOfPreviousProject !== undefined)
                for (const oldFile of filesOfPreviousProject)
                    if (!ownFiles.includes(oldFile))
                        host.uncacheFile(oldFile);
            filesOfPreviousProject = ownFiles;

            if (files.length !== 0)
                yield {files, program, configFilePath};
        }
        ensurePatternsMatch(nonMagicGlobs, ex, allMatchedFiles, projectsSeen);

        function isFileIncluded(fileName: string) {
            return (include.length === 0 || include.some((p) => p.match(fileName))) && !ex.some((p) => p.match(fileName));
        }
    }

    private matchProjectGlobs(projects: ReadonlyArray<string>) {
        const cwd = this.directories.getCurrentDirectory();
        const result = [];
        const globOptions: glob.IOptions = {
            cwd,
            nobrace: true, // braces are already expanded
            cache: {},
            realpathCache: {},
            statCache: {},
            symlinks: {},
        };
        for (const project of projects) {
            if (!glob.hasMagic(project)) {
                result.push(this.checkConfigDirectory(unixifyPath(path.resolve(cwd, project))));
            } else {
                let matched = false;
                for (const pattern of normalizeGlob(project, cwd)) {
                    log("globbing project pattern '%s'", pattern);
                    for (const match of glob.sync(pattern, globOptions)) {
                        matched = true;
                        result.push(this.checkConfigDirectory(unixifyPath(match)));
                    }
                }
                if (!matched)
                    throw new ConfigurationError(`The specified pattern does not match any file: '${project}'`);
            }

        }
        return result;
    }

    private checkConfigDirectory(fileOrDirName: string): string {
        switch (this.fs.getKind(fileOrDirName)) {
            case FileKind.NonExistent:
                throw new ConfigurationError(`The specified path does not exist: '${fileOrDirName}'`);
            case FileKind.Directory: {
                const file = unixifyPath(path.join(fileOrDirName, 'tsconfig.json'));
                if (!this.fs.isFile(file))
                    throw new ConfigurationError(`Cannot find a tsconfig.json file at the specified directory: '${fileOrDirName}'`);
                return file;
            }
            default:
                return fileOrDirName;
        }
    }

    private* createPrograms(
        projects: ReadonlyArray<string> | ReadonlyArray<ts.ResolvedProjectReference | undefined>,
        host: ProjectHost,
        seen: string[],
        references: boolean,
        isFileIncluded: (fileName: string) => boolean,
    ): Iterable<{program: ts.Program, configFilePath: string}> {
        for (const configFile of projects) {
            if (configFile === undefined)
                continue;
            const configFilePath = typeof configFile === 'string' ? configFile : configFile.sourceFile.fileName;
            if (!addUnique(seen, configFilePath))
                continue;

            let commandLine;
            if (typeof configFile !== 'string') {
                ({commandLine} = configFile);
            } else {
                commandLine = host.getParsedCommandLine(configFile);
                if (commandLine === undefined)
                    continue;
            }
            if (commandLine.errors.length !== 0)
                this.logger.warn(ts.formatDiagnostics(commandLine.errors, host));
            if (commandLine.fileNames.length !== 0) {
                if (!commandLine.options.composite || commandLine.fileNames.some((file) => isFileIncluded(host.getFileSystemFile(file)!))) {
                    log("Using project '%s'", configFilePath);
                    let resolvedReferences;
                    {
                        // this is in a nested block to allow garbage collection while recursing
                        const program =
                            host.createProgram(commandLine.fileNames, commandLine.options, undefined, commandLine.projectReferences);
                        yield {program, configFilePath};
                        if (references)
                            resolvedReferences = program.getResolvedProjectReferences();
                    }
                    if (resolvedReferences !== undefined)
                        yield* this.createPrograms(resolvedReferences, host, seen, true, isFileIncluded);
                    continue;
                }
                log("Project '%s' contains no file to lint", configFilePath);
            }
            if (references) {
                if (typeof configFile !== 'string') {
                    if (configFile.references !== undefined)
                        yield* this.createPrograms(configFile.references, host, seen, true, isFileIncluded);
                } else if (commandLine.projectReferences !== undefined) {
                    yield* this.createPrograms(
                        commandLine.projectReferences.map((ref) => this.checkConfigDirectory(ref.path)),
                        host,
                        seen,
                        true,
                        isFileIncluded,
                    );
                }
            }
        }
    }
}

function getFiles(patterns: ReadonlyArray<NormalizedGlob>, exclude: ReadonlyArray<string>, cwd: string): Iterable<string> {
    const result: string[] = [];
    const globOptions: glob.IOptions = {
        cwd,
        nobrace: true, // braces are already expanded
        cache: {},
        ignore: exclude,
        nodir: true,
        realpathCache: {},
        statCache: {},
        symlinks: {},
    };
    for (const pattern of patterns) {
        let matched = pattern.hasMagic;
        for (const normalized of pattern.normalized) {
            const match = glob.sync(normalized, globOptions);
            if (match.length !== 0) {
                matched = true;
                result.push(...match);
            }
        }
        if (!matched && !isExcluded(pattern.normalized[0], exclude.map((p) => new Minimatch(p, {dot: true}))))
            throw new ConfigurationError(`'${pattern.normalized[0]}' does not exist.`);
    }
    return new Set(result.map(unixifyPath)); // deduplicate files
}

interface NonMagicGlob {
    raw: string;
    match: IMinimatch;
}

function ensurePatternsMatch(include: NonMagicGlob[], exclude: IMinimatch[], files: string[], projects: ReadonlyArray<string>) {
    for (const pattern of include)
        if (!isExcluded(pattern.raw, exclude) && !files.some((f) => pattern.match.match(f)))
            throw new ConfigurationError(`'${pattern.raw}' is not included in any of the projects: '${projects.join("', '")}'.`);
}

function isExcluded(file: string, exclude: IMinimatch[]): boolean {
    for (const e of exclude)
        if (e.match(file))
            return true;
    return false;
}

function shouldFix(sourceFile: ts.SourceFile, options: Pick<LintOptions, 'fix'>, originalName: string) {
    if (options.fix && hasParseErrors(sourceFile)) {
        log("Not fixing '%s' because of parse errors.", originalName);
        return false;
    }
    return options.fix;
}
