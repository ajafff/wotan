import 'reflect-metadata';
import * as ts from 'typescript';
import { WrappedAst, isStrictCompilerOptionEnabled, BooleanCompilerOptions, isCompilerOptionEnabled } from 'tsutils';
import * as path from 'path';

export class ConfigurationError extends Error {}

export abstract class GlobalOptions {
    readonly [key: string]: {} | null | undefined;
}

export type LintResult = Iterable<[string, FileSummary]>;

export type FileSummary = LintAndFixFileResult;

export interface LintAndFixFileResult {
    content: string;
    failures: ReadonlyArray<Failure>;
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

export interface Fix {
    readonly replacements: ReadonlyArray<Replacement>;
}

export interface Failure {
    readonly start: FailurePosition;
    readonly end: FailurePosition;
    readonly message: string;
    readonly ruleName: string;
    readonly severity: Severity;
    readonly fix: Fix | undefined;
}

export const Failure = {
    /** Compare two Failures. Intended to be used in `Array.prototype.sort`. */
    compare(a: Failure, b: Failure): number {
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

export interface FailurePosition {
    readonly line: number;
    readonly character: number;
    readonly position: number;
}

export type Severity = 'error' | 'warning';

export interface RuleConstructor<T extends RuleContext = RuleContext> {
    readonly requiresTypeInformation: boolean;
    readonly deprecated?: boolean | string;
    supports?: RuleSupportsPredicate;
    new(context: T): AbstractRule;
}

export interface RuleSupportsContext {
    readonly program?: ts.Program;
    readonly settings: Settings;
    readonly options: {} | null | undefined;
}

export interface RuleContext {
    readonly program?: ts.Program;
    readonly sourceFile: ts.SourceFile;
    readonly settings: Settings;
    readonly options: {} | null | undefined;
    addFailure(start: number, end: number, message: string, fix?: Replacement | ReadonlyArray<Replacement>): void;
    getFlatAst(): ReadonlyArray<ts.Node>;
    getWrappedAst(): WrappedAst;
}
export abstract class RuleContext {}

export interface TypedRuleContext extends RuleContext {
    readonly program: ts.Program;
}
export abstract class TypedRuleContext {}

export type Settings = ReadonlyMap<string, {} | null | undefined>;

function combinePredicates(existing: RuleSupportsPredicate | undefined, predicate: RuleSupportsPredicate): RuleSupportsPredicate {
    if (existing === undefined)
        return predicate;
    return (sourceFile, context) => predicate(sourceFile, context) && existing(sourceFile, context);
}

export function isTypescriptFile(sourceFile: ts.SourceFile) {
    return /\.tsx?$/.test(sourceFile.fileName);
}

export function typescriptOnly(target: typeof AbstractRule) {
    target.supports = combinePredicates(target.supports, isTypescriptFile);
}

export function excludeDeclarationFiles(target: typeof AbstractRule) {
    target.supports = combinePredicates(target.supports, (sourceFile) => !sourceFile.isDeclarationFile);
}

export function requireLibraryFile(fileName: string) {
    return (target: typeof TypedRule) => {
        target.supports = combinePredicates(target.supports, (_, context) => programContainsLibraryFile(context.program!, fileName));
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
            (_, context) => isCompilerOptionEnabled(context.program!.getCompilerOptions(), option),
        );
    };
}

/** @deprecated Use `requiresCompilerOption` instead. */
export function requiresStrictNullChecks(target: typeof TypedRule) {
    target.supports = combinePredicates(
        target.supports,
        (_, context) => isStrictCompilerOptionEnabled(context.program!.getCompilerOptions(), 'strictNullChecks'),
    );
}

export type RuleSupportsPredicate = (sourceFile: ts.SourceFile, context: RuleSupportsContext) => boolean;

export abstract class AbstractRule {
    public static readonly requiresTypeInformation: boolean = false;
    public static deprecated: boolean | string = false;
    public static supports?: RuleSupportsPredicate = undefined;
    public static validateConfig?(config: any): string[] | string | undefined;

    public readonly sourceFile: ts.SourceFile;
    public readonly program: ts.Program | undefined;

    constructor(public readonly context: RuleContext) {
        this.sourceFile = context.sourceFile;
        this.program = context.program;
    }

    public abstract apply(): void;

    public addFailure(start: number, end: number, message: string, fix?: Replacement | ReadonlyArray<Replacement>) {
        return this.context.addFailure(start, end, message, fix);
    }

    public addFailureAtNode(node: ts.Node, message: string, fix?: Replacement | ReadonlyArray<Replacement>) {
        return this.addFailure(node.getStart(this.sourceFile), node.end, message, fix);
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
    public readonly context!: TypedRuleContext;
    public readonly program!: ts.Program;

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
    export type RuleSeverity = 'off' | 'warning' | 'error';
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

    public abstract postprocess(failures: ReadonlyArray<Failure>): ReadonlyArray<Failure>;

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
    /** Gets the status of a file or directory, not resolving symlinks. */
    lstat(path: string): LStats;
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

export interface LStats extends Stats {
    isSymbolicLink(): boolean;
}

export interface Dirent extends LStats {
    name: string;
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
    resolve(id: string, basedir: string, extensions: ReadonlyArray<string>, paths?: ReadonlyArray<string>): string;
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

export interface FailureFilterFactory {
    create(context: FailureFilterContext): FailureFilter;
}
export abstract class FailureFilterFactory {}

export interface FailureFilterContext {
    sourceFile: ts.SourceFile;
    ruleNames: ReadonlyArray<string>;
    getWrappedAst(): WrappedAst;
}

export interface FailureFilter {
    /** @returns `true` if the failure should be used, false if it should be filtered out. Intended for use in `Array.prototype.filter`. */
    filter(failure: Failure): boolean;
}

export interface LineSwitchParser {
    parse(context: LineSwitchParserContext): ReadonlyMap<string, ReadonlyArray<RawLineSwitch>>;
}
export abstract class LineSwitchParser {}

export interface LineSwitchParserContext {
    sourceFile: ts.SourceFile;
    ruleNames: ReadonlyArray<string>;
    getCommentAtPosition(pos: number): ts.CommentRange | undefined;
}

export interface RawLineSwitch {
    readonly enable: boolean;
    readonly position: number;
}
