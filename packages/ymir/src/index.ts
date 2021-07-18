import 'reflect-metadata';
import * as ts from 'typescript';
import { WrappedAst, BooleanCompilerOptions, isCompilerOptionEnabled } from 'tsutils';
import * as path from 'path';

export class ConfigurationError extends Error {}

export abstract class GlobalOptions {
    readonly [key: string]: {} | null | undefined;
}

export type LintResult = Iterable<[string, FileSummary]>;

export type FileSummary = LintAndFixFileResult;

export type OneOrMany<T> = T | ReadonlyArray<T>;

export interface LintAndFixFileResult {
    content: string;
    findings: ReadonlyArray<Finding>;
    fixes: number;
}

export interface Replacement {
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

export const Replacement = {
    replace(start: number, end: number, text: string): Replacement {
        return {start, end, text};
    },
    append(pos: number, text: string): Replacement {
        return {start: pos, end: pos, text}; // tslint:disable-line:object-shorthand-properties-first
    },
    delete(start: number, end: number): Replacement {
        return {start, end, text: ''};
    },
};

export interface CodeAction {
    readonly description: string;
    readonly replacements: readonly Replacement[];
}

export const CodeAction = {
    create(description: string, replacements: OneOrMany<Replacement>): CodeAction {
        return {
            description,
            replacements: Array.isArray(replacements) ? replacements : [replacements],
        };
    },
};

export interface Finding {
    readonly start: FindingPosition;
    readonly end: FindingPosition;
    readonly message: string;
    readonly ruleName: string;
    readonly severity: Severity;
    readonly fix: CodeAction | undefined;
    readonly codeActions: ReadonlyArray<CodeAction> | undefined;
}

export const Finding = {
    /** Compare two Findings. Intended to be used in `Array.prototype.sort`. */
    compare(a: Finding, b: Finding): number {
        return a.start.position - b.start.position
            || a.end.position - b.end.position
            || compareStrings(a.ruleName, b.ruleName)
            || compareStrings(a.message, b.message);
    },
};

function compareStrings(a: string, b: string): number {
    return a < b
        ? -1
        : a > b
            ? 1
            : 0;
}

export interface FindingPosition {
    readonly line: number;
    readonly character: number;
    readonly position: number;
}

export type Severity = 'error' | 'warning' | 'suggestion';

export interface RuleConstructor<T extends RuleContext = RuleContext> {
    readonly requiresTypeInformation: boolean;
    readonly deprecated?: boolean | string;
    supports?: RulePredicate;
    new(context: T): AbstractRule;
}

export interface RulePredicateContext {
    readonly program?: ts.Program;
    readonly compilerOptions?: ts.CompilerOptions;
    readonly settings: Settings;
    readonly options: {} | null | undefined;
}

export interface RuleContext extends RulePredicateContext {
    readonly sourceFile: ts.SourceFile;
    addFinding(
        start: number,
        end: number,
        message: string,
        fix?: OneOrMany<Replacement> | CodeAction,
        codeActions?: OneOrMany<CodeAction>,
    ): void;
    getFlatAst(): ReadonlyArray<ts.Node>;
    getWrappedAst(): WrappedAst;
}

export interface TypedRuleContext extends RuleContext {
    readonly program: ts.Program;
    readonly compilerOptions: ts.CompilerOptions;
}

export type Settings = ReadonlyMap<string, {} | null | undefined>;

export function predicate(check: RulePredicate) {
    return (target: typeof AbstractRule) => {
        target.supports = combinePredicates(target.supports, check);
    };
}

function combinePredicates(existing: RulePredicate | undefined, additonal: RulePredicate): RulePredicate {
    if (existing === undefined)
        return additonal;
    return (sourceFile, context) => {
        const result = additonal(sourceFile, context);
        return result !== true ? result : existing(sourceFile, context);
    };
}

export function typescriptOnly(target: typeof AbstractRule) {
    target.supports = combinePredicates(target.supports, (sourceFile) => /\.tsx?$/.test(sourceFile.fileName) || 'TypeScript only');
}

export function excludeDeclarationFiles(target: typeof AbstractRule) {
    target.supports = combinePredicates(target.supports, (sourceFile) => !sourceFile.isDeclarationFile || 'excludes declaration files');
}

export function requireLibraryFile(fileName: string) {
    return (target: typeof TypedRule) => {
        target.supports = combinePredicates(
            target.supports,
            (_, context) => programContainsLibraryFile(context.program!, fileName) || `requires library file '${fileName}'`,
        );
    };
}

function programContainsLibraryFile(program: ts.Program, fileName: string) {
    const libFileDir = path.dirname(ts.getDefaultLibFilePath(program.getCompilerOptions()));
    return program.getSourceFile(path.join(libFileDir, fileName)) !== undefined;
}

export function requiresCompilerOption(option: BooleanCompilerOptions) {
    return (target: typeof TypedRule) => {
        target.supports = combinePredicates(
            target.supports,
            (_, context) => isCompilerOptionEnabled(context.compilerOptions!, option) || `requires compilerOption '${option}'`,
        );
    };
}

/** @returns `true`, `false` or a reason */
export type RulePredicate = (sourceFile: ts.SourceFile, context: RulePredicateContext) => boolean | string;

export abstract class AbstractRule {
    public static readonly requiresTypeInformation: boolean = false;
    public static deprecated: boolean | string = false;
    public static supports?: RulePredicate = undefined;
    public static validateConfig?(config: any): OneOrMany<string> | undefined;

    public readonly sourceFile: ts.SourceFile;

    public get program() {
        return this.context.program;
    }

    constructor(public readonly context: RuleContext) {
        this.sourceFile = context.sourceFile;
    }

    public abstract apply(): void;

    public addFinding(
        start: number,
        end: number,
        message: string,
        fix?: OneOrMany<Replacement> | CodeAction,
        codeActions?: OneOrMany<CodeAction>,
    ) {
        return this.context.addFinding(start, end, message, fix, codeActions);
    }

    public addFindingAtNode(
        node: ts.Node,
        message: string,
        fix?: OneOrMany<Replacement> | CodeAction,
        codeActions?: OneOrMany<CodeAction>,
    ) {
        return this.addFinding(node.getStart(this.sourceFile), node.end, message, fix, codeActions);
    }
}

export abstract class ConfigurableRule<T> extends AbstractRule {
    public options: T;

    constructor(context: RuleContext) {
        super(context);
        this.options = this.parseOptions(context.options);
    }

    protected abstract parseOptions(options: {} | null | undefined): T;
}

export abstract class TypedRule extends AbstractRule {
    public static readonly requiresTypeInformation = true;
    declare public readonly context: TypedRuleContext;
    public get program() {
        return this.context.program;
    }

    /** Lazily evaluated getter for TypeChecker. Use this instead of `this.program.getTypeChecker()` to avoid wasting CPU cycles. */
    public get checker() {
        const checker = this.program.getTypeChecker();
        Object.defineProperty(this, 'checker', {value: checker, writable: false});
        return checker;
    }

    constructor(context: TypedRuleContext) {
        super(context);
    }
}

export abstract class ConfigurableTypedRule<T> extends TypedRule {
    public options: T;

    constructor(context: TypedRuleContext) {
        super(context);
        this.options = this.parseOptions(context.options);
    }

    protected abstract parseOptions(options: {} | null | undefined): T;
}

export abstract class AbstractFormatter {
    public prefix?: string;
    public abstract format(filename: string, summary: FileSummary): string | undefined;
    public flush?(): string | undefined;
}

export interface FormatterConstructor {
    new(): AbstractFormatter;
}

export interface Configuration {
    readonly aliases?: ReadonlyMap<string, Configuration.Alias>;
    readonly rules?: ReadonlyMap<string, Configuration.RuleConfig>;
    readonly settings?: Settings;
    readonly filename: string;
    readonly overrides?: ReadonlyArray<Configuration.Override>;
    readonly extends: ReadonlyArray<Configuration>;
    readonly rulesDirectories?: Configuration.RulesDirectoryMap;
    readonly processor?: string | null | false;
    readonly exclude?: ReadonlyArray<string>;
}

export namespace Configuration {
    export type RulesDirectoryMap = ReadonlyMap<string, ReadonlyArray<string>>;
    export type RuleSeverity = 'off' | 'warning' | 'error' | 'suggestion';
    export interface RuleConfig {
        readonly severity?: RuleSeverity;
        readonly options?: any;
        readonly rulesDirectories: ReadonlyArray<string> | undefined;
        readonly rule: string;
    }
    export interface Override {
        readonly rules?: ReadonlyMap<string, RuleConfig>;
        readonly settings?: ReadonlyMap<string, any>;
        readonly files: ReadonlyArray<string>;
        readonly processor?: string | null | false;
    }
    export interface Alias {
        readonly rule: string;
        readonly options?: any;
        readonly rulesDirectories: ReadonlyArray<string> | undefined;
    }
}

export interface EffectiveConfiguration {
    rules: Map<string, EffectiveConfiguration.RuleConfig>;
    settings: Map<string, any>;
}

export namespace EffectiveConfiguration {
    export interface RuleConfig {
        severity: Configuration.RuleSeverity;
        options: any;
        rulesDirectories: ReadonlyArray<string> | undefined;
        rule: string;
    }
}

export interface ReducedConfiguration extends EffectiveConfiguration {
    processor: string | undefined;
}

export interface ConfigurationProvider {
    find(fileToLint: string): string | undefined;
    resolve(name: string, basedir: string): string;
    load(fileName: string, context: LoadConfigurationContext): Configuration;
}
export abstract class ConfigurationProvider {}

export interface LoadConfigurationContext {
    readonly stack: ReadonlyArray<string>;
    /**
     * Resolves the given name relative to the current configuration file and returns the parsed Configuration.
     * This function detects cycles and caches already loaded configurations.
     */
    load(name: string): Configuration;
}

export const enum Format {
    Yaml = 'yaml',
    Json = 'json',
    Json5 = 'json5',
}

export interface ProcessorConstructor {
    getSuffixForFile(context: ProcessorSuffixContext): string;
    new(context: ProcessorContext): AbstractProcessor;
}

export interface ProcessorSuffixContext {
    fileName: string;
    getSettings(): Settings;
    readFile(): string;
}

export interface ProcessorContext {
    source: string;
    sourceFileName: string;
    targetFileName: string;
    settings: Settings;
}

export interface ProcessorUpdateResult {
    transformed: string;
    changeRange?: ts.TextChangeRange;
}

export abstract class AbstractProcessor {
    /**
     * Returns a new primary extension that is appended to the file name, e.g. '.ts'.
     * If the file should not get a new extension, just return an empty string.
     */
    public static getSuffixForFile(_context: ProcessorSuffixContext): string {
        return '';
    }

    protected source: string;
    protected sourceFileName: string;
    protected targetFileName: string;
    protected settings: Settings;

    constructor(context: ProcessorContext) {
        this.source = context.source;
        this.sourceFileName = context.sourceFileName;
        this.targetFileName = context.targetFileName;
        this.settings = context.settings;
    }

    public abstract preprocess(): string;

    public abstract postprocess(findings: ReadonlyArray<Finding>): ReadonlyArray<Finding>;

    public abstract updateSource(newSource: string, changeRange: ts.TextChangeRange): ProcessorUpdateResult;
}

export interface MessageHandler {
    log(message: string): void;
    warn(message: string): void;
    error(e: Error): void;
}
export abstract class MessageHandler {}

export interface DeprecationHandler {
    handle(target: DeprecationTarget, name: string, text?: string): void;
}
export abstract class DeprecationHandler {}

export const enum DeprecationTarget {
    Rule = 'rule',
    Processor = 'processor',
    Formatter = 'formatter',
}

/**
 * Low level file system access. All methods are supposed to throw an error on failure.
 */
export interface FileSystem {
    /** Normalizes the path to enable reliable caching in consuming services. */
    normalizePath(path: string): string;
    /** Reads the given file. Tries to infer and convert encoding. */
    readFile(file: string): string;
    /** Reads directory entries. Returns only the basenames optionally with file type information. */
    readDirectory(dir: string): Array<string | Dirent>;
    /** Gets the status of a file or directory. */
    stat(path: string): Stats;
    /** Gets the realpath of a given file or directory. */
    realpath?(path: string): string;
    /** Writes content to the file, overwriting the existing content. Creates the file if necessary. */
    writeFile(file: string, content: string): void;
    /** Deletes a given file. Is not supposed to delete or clear a directory. */
    deleteFile(path: string): void;
    /** Creates a single directory and fails on error. Is not supposed to create multiple directories. */
    createDirectory(dir: string): void;
}
export abstract class FileSystem {}

export interface Stats {
    isDirectory(): boolean;
    isFile(): boolean;
}

export interface Dirent extends Stats {
    name: string;
    isSymbolicLink(): boolean;
}

export interface RuleLoaderHost {
    loadCoreRule(name: string): RuleConstructor | undefined;
    loadCustomRule(name: string, directory: string): RuleConstructor | undefined;
}
export abstract class RuleLoaderHost {}

export interface FormatterLoaderHost {
    loadCoreFormatter(name: string): FormatterConstructor | undefined;
    loadCustomFormatter(name: string, basedir: string): FormatterConstructor | undefined;
}
export abstract class FormatterLoaderHost {}

// wotan-disable no-misused-generics
export interface CacheFactory {
    /** Creates a new cache instance. */
    create<K extends object, V = any>(weak: true): Cache<K, V>;
    create<K = any, V = any>(weak?: false): Cache<K, V>;
}
// wotan-enable no-misused-generics
export abstract class CacheFactory {}

export interface Cache<K, V> {
    get(key: K): V | undefined;
    set(key: K, value: V): void;
    delete(key: K): void;
    has(key: K): boolean;
    clear(): void;
}

export interface Resolver {
    getDefaultExtensions(): ReadonlyArray<string>;
    resolve(id: string, basedir?: string, extensions?: ReadonlyArray<string>, paths?: ReadonlyArray<string>): string;
    require(id: string, options?: {cache?: boolean}): any;
}
export abstract class Resolver {}

export interface BuiltinResolver {
    resolveConfig(name: string): string;
    resolveRule(name: string): string;
    resolveFormatter(name: string): string;
}
export abstract class BuiltinResolver {}

export interface DirectoryService {
    getCurrentDirectory(): string;
    getHomeDirectory?(): string;
}
export abstract class DirectoryService {}

export interface FindingFilterFactory {
    create(context: FindingFilterContext): FindingFilter;
}
export abstract class FindingFilterFactory {}

export interface FindingFilterContext {
    sourceFile: ts.SourceFile;
    ruleNames: ReadonlyArray<string>;
    getWrappedAst(): WrappedAst;
}

export interface FindingFilter {
    /** @returns `true` if the finding should be used, false if it should be filtered out. Intended for use in `Array.prototype.filter`. */
    filter(finding: Finding): boolean;
    /**
     * @returns Findings to report redundant or unused filter directives.
     * This is called after calling `filter` for all findings in the file.
     */
    reportUseless(severity: Severity): ReadonlyArray<Finding>;
}

export interface LineSwitchParser {
    parse(context: LineSwitchParserContext): ReadonlyArray<RawLineSwitch>;
}
export abstract class LineSwitchParser {}

export interface LineSwitchParserContext {
    sourceFile: ts.SourceFile;
    getCommentAtPosition(pos: number): ts.CommentRange | undefined;
}

export interface RawLineSwitch {
    readonly rules: ReadonlyArray<RawLineSwitchRule>;
    readonly enable: boolean;
    readonly pos: number;
    readonly end?: number;
    readonly location: Readonly<ts.TextRange>;
}

export interface RawLineSwitchRule {
    readonly predicate: string | RegExp | ((ruleName: string) => boolean);
    readonly location?: Readonly<ts.TextRange>;
    readonly fixLocation?: Readonly<ts.TextRange>;
}

export interface FileFilterContext {
    program: ts.Program;
    host: Required<Pick<ts.CompilerHost, 'directoryExists'>>;
}

export interface FileFilterFactory {
    create(context: FileFilterContext): FileFilter;
}
export abstract class FileFilterFactory {}

export interface FileFilter {
    /** @returns `true` if the file should be linted, false if it should be filtered out. Intended for use in `Array.prototype.filter`. */
    filter(file: ts.SourceFile): boolean;
}

export type ContentIdHost = Pick<ts.CompilerHost, 'readFile'>;

export interface ContentId {
    forFile(fileName: string, host: ContentIdHost): string;
}
export abstract class ContentId {}

export interface StatePersistence {
    loadState(project: string): StaticProgramState | undefined;
    saveState(project: string, state: StaticProgramState): void;
}
export abstract class StatePersistence {}

export interface StaticProgramState {
    /** Version of the cache format */
    readonly v: number;
    /** TypeScript version */
    readonly ts: string;
    /** Whether the state was created using case-sensitive file names */
    readonly cs: boolean;
    /** Hash of compilerOptions */
    readonly options: string;
    /** Maps filename to index in 'files' array */
    readonly lookup: Readonly<Record<string, number>>;
    /** Index of files that affect global scope */
    readonly global: readonly number[];
    /** Information about all files in the program */
    readonly files: readonly StaticProgramState.FileState[];
}

export namespace StaticProgramState {
    export interface FileState {
        /** ID of file contents (typically a hash) */
        readonly id: string;
        /**
         * Key: module specifier as referenced in the file, order may be random
         * Value: - `null` if dependency could not be resolved
         *        - List of files (or rather their index) that the module specifier resolves to.
         *          That is the actual file at that path and/or files containing `declare module "..."` for that module specifier.
         *          May contain the current file.
         *          This list is ordered by the ID of the files ascending,
         */
        readonly dependencies?: Readonly<Record<string, null | readonly number[]>>;
        /** The list of findings if this file has up-to-date results */
        readonly result?: readonly Finding[];
        /** Hash of the configuration used to produce `result` for this file */
        readonly config?: string;
    }
}
