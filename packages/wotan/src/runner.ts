import { Linter } from './linter';
import {
    LintResult,
    FileSummary,
    Configuration,
    AbstractProcessor,
    DirectoryService,
    ConfigurationError,
    MessageHandler,
} from '@fimbul/ymir';
import * as path from 'path';
import * as ts from 'typescript';
import * as glob from 'glob';
import { unixifyPath, hasSupportedExtension } from './utils';
import { Minimatch, IMinimatch } from 'minimatch';
import { ProcessorLoader } from './services/processor-loader';
import { injectable } from 'inversify';
import { CachedFileSystem, FileKind } from './services/cached-file-system';
import { ConfigurationManager } from './services/configuration-manager';
import { ProjectHost } from './project-host';
import debug = require('debug');

const log = debug('wotan:runner');

export interface LintOptions {
    config: string | undefined;
    files: string[];
    exclude: string[];
    project: string | undefined;
    fix: boolean | number;
    extensions: string[] | undefined;
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
    ) {}

    public lintCollection(options: LintOptions): LintResult {
        const config = options.config !== undefined ? this.configManager.loadLocalOrResolved(options.config) : undefined;
        if (options.project === undefined && options.files.length !== 0)
            return this.lintFiles(options, config);

        return this.lintProject(options, config);
    }

    private *lintProject(options: LintOptions, config: Configuration | undefined): LintResult {
        const processorHost = new ProjectHost(
            this.directories.getCurrentDirectory(),
            config,
            this.fs,
            this.configManager,
            this.processorLoader,
        );
        let {files, program} = this.getFilesAndProgram(options.project, options.files, options.exclude, processorHost);

        for (const file of files) {
            if (!hasSupportedExtension(file))
                continue;
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
            if (fix) {
                summary = this.linter.lintAndFix(
                    sourceFile,
                    originalContent,
                    effectiveConfig,
                    (content, range) => {
                        ({sourceFile, program} = processorHost.updateSourceFile(sourceFile, program, content, range));
                        return {program, file: sourceFile};
                    },
                    fix === true ? undefined : fix,
                    program,
                    mapped === undefined ? undefined : mapped.processor,
                );
            } else {
                summary = {
                    failures: this.linter.getFailures(
                        sourceFile,
                        effectiveConfig,
                        program,
                        mapped === undefined ? undefined : mapped.processor,
                    ),
                    fixes: 0,
                    content: originalContent,
                };
            }
            yield [originalName, summary];
        }
    }

    private *lintFiles(options: LintOptions, config: Configuration | undefined): LintResult {
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
                        return {file: sourceFile};
                    },
                    fix === true ? undefined : fix,
                    undefined,
                    processor,
                );
            } else {
                summary = {
                    failures: this.linter.getFailures(
                        sourceFile,
                        effectiveConfig,
                        undefined,
                        processor,
                    ),
                    fixes: 0,
                    content: originalContent,
                };
            }
            yield [file, summary];
        }
    }

    private getFilesAndProgram(
        project: string | undefined,
        patterns: string[],
        exclude: string[],
        host: ProjectHost,
    ): {files: Iterable<string>, program: ts.Program} {
        const cwd = this.directories.getCurrentDirectory();
        if (project !== undefined) {
            project = this.checkConfigDirectory(path.resolve(cwd, project));
        } else {
            project = ts.findConfigFile(cwd, (f) => this.fs.isFile(f));
            if (project === undefined)
                throw new ConfigurationError(`Cannot find tsconfig.json for directory '${cwd}'.`);
        }
        const program = this.createProgram(project, host);
        const files: string[] = [];
        const originalNames: string [] = [];
        const libDirectory = unixifyPath(path.dirname(ts.getDefaultLibFilePath(program.getCompilerOptions()))) + '/';
        const include = patterns.map((p) => new Minimatch(p));
        const ex = exclude.map((p) => new Minimatch(p, {dot: true}));
        const typeRoots = ts.getEffectiveTypeRoots(program.getCompilerOptions(), host);
        outer: for (const sourceFile of program.getSourceFiles()) {
            const {fileName} = sourceFile;
            if (fileName.startsWith(libDirectory) || // lib.xxx.d.ts
                // tslib implicitly gets added while linting a project where a dependecy in node_modules contains typescript files
                // for some reason they are not correctly marked as external library
                // therefore we always ignore it
                fileName.endsWith('/node_modules/tslib/tslib.d.ts'))
                continue;
            if (program.isSourceFileFromExternalLibrary(sourceFile))
                continue;
            if (typeRoots !== undefined) {
                for (const typeRoot of typeRoots) {
                    const relative = path.relative(typeRoot, fileName);
                    if (!relative.startsWith('..' + path.sep))
                        continue outer;
                }
            }
            const originalName = path.relative(cwd, host.getFileSystemFile(fileName)!);
            if (include.length !== 0 && !include.some((e) => e.match(originalName)))
                continue;
            if (ex.some((e) => e.match(originalName)))
                continue;
            files.push(fileName);
            originalNames.push(originalName);
        }
        ensurePatternsMatch(include, ex, originalNames);
        return {files, program};
    }

    private checkConfigDirectory(fileOrDirName: string): string {
        switch (this.fs.getKind(fileOrDirName)) {
            case FileKind.NonExistent:
                throw new ConfigurationError(`The specified path does not exist: '${fileOrDirName}'`);
            case FileKind.Directory: {
                const file = path.join(fileOrDirName, 'tsconfig.json');
                if (!this.fs.isFile(file))
                    throw new ConfigurationError(`Cannot find a tsconfig.json file at the specified directory: '${fileOrDirName}'`);
                return file;
            }
            default:
                return fileOrDirName;
        }
    }

    private createProgram(configFile: string, host: ProjectHost): ts.Program {
        const config = ts.readConfigFile(configFile, (file) => host.readFile(file));
        if (config.error !== undefined) {
            this.logger.warn(ts.formatDiagnostics([config.error], host));
            config.config = {};
        }
        const parsed = ts.parseJsonConfigFileContent(
            config.config,
            createParseConfigHost(host),
            path.dirname(configFile),
            {noEmit: true},
            configFile,
        );
        if (parsed.errors.length !== 0)
            this.logger.warn(ts.formatDiagnostics(parsed.errors, host));
        return ts.createProgram(parsed.fileNames, parsed.options, host);
    }
}

function getFiles(patterns: string[], exclude: string[], cwd: string): Iterable<string> {
    const result: string[] = [];
    const globOptions = {
        cwd,
        absolute: true,
        cache: {},
        ignore: exclude,
        nodir: true,
        realpathCache: {},
        statCache: {},
        symlinks: {},
    };
    for (const pattern of patterns) {
        const match = glob.sync(pattern, globOptions);
        if (match.length !== 0) {
            result.push(...match);
        } else if (!glob.hasMagic(pattern)) {
            const normalized = new Minimatch(pattern).set[0].join('/');
            if (!isExcluded(normalized, exclude.map((p) => new Minimatch(p, {dot: true}))))
                throw new ConfigurationError(`'${normalized}' does not exist.`);
        }
    }
    return new Set(result.map(unixifyPath)); // deduplicate files
}

function ensurePatternsMatch(include: IMinimatch[], exclude: IMinimatch[], files: string[]) {
    for (const pattern of include) {
        if (!glob.hasMagic(pattern.pattern)) {
            const normalized = pattern.set[0].join('/');
            if (!files.includes(normalized) && !isExcluded(normalized, exclude))
                throw new ConfigurationError(`'${normalized}' is not included in the project.`);
        }
    }
}

function isExcluded(file: string, exclude: IMinimatch[]): boolean {
    for (const e of exclude)
        if (e.match(file))
            return true;
    return false;
}

function hasParseErrors(sourceFile: ts.SourceFile) {
    return sourceFile.parseDiagnostics.length !== 0;
}

function shouldFix(sourceFile: ts.SourceFile, options: LintOptions, originalName: string) {
    if (options.fix && hasParseErrors(sourceFile)) {
        log("Not fixing '%s' because of parse errors.", originalName);
        return false;
    }
    return options.fix;
}

declare module 'typescript' {
    export function matchFiles(
        path: string,
        extensions: ReadonlyArray<string>,
        excludes: ReadonlyArray<string> | undefined,
        includes: ReadonlyArray<string>,
        useCaseSensitiveFileNames: boolean,
        currentDirectory: string,
        depth: number | undefined,
        getFileSystemEntries: (path: string) => ts.FileSystemEntries,
    ): string[];

    export interface FileSystemEntries {
        readonly files: ReadonlyArray<string>;
        readonly directories: ReadonlyArray<string>;
    }

    export interface SourceFile {
        parseDiagnostics: ts.DiagnosticWithLocation[];
    }
}

function createParseConfigHost(host: ProjectHost): ts.ParseConfigHost {
    return {
        useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
        readDirectory(rootDir, extensions, excludes, includes, depth) {
            return ts.matchFiles(rootDir, extensions, excludes, includes, ts.sys.useCaseSensitiveFileNames, host.cwd, depth, getEntries);
        },
        fileExists(f) {
            return host.fileExists(f);
        },
        readFile(f) {
            return host.readFile(f);
        },
    };

    function getEntries(dir: string) {
        return host.getDirectoryEntries(dir);
    }
}
