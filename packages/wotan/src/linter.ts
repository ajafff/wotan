import * as ts from 'typescript';
import {
    Finding,
    EffectiveConfiguration,
    LintAndFixFileResult,
    RuleContext,
    Severity,
    RuleConstructor,
    MessageHandler,
    AbstractProcessor,
    DeprecationHandler,
    DeprecationTarget,
    FindingFilterFactory,
    FindingFilter,
    OneOrMany,
    Replacement,
    CodeAction,
} from '@fimbul/ymir';
import { applyFixes } from './fix';
import * as debug from 'debug';
import { injectable } from 'inversify';
import { RuleLoader } from './services/rule-loader';
import { calculateChangeRange, emptyArray, invertChangeRange, mapDefined } from './utils';
import { ConvertedAst, convertAst, isCompilerOptionEnabled, getTsCheckDirective } from 'tsutils';

const log = debug('wotan:linter');

export interface LinterOptions {
    reportUselessDirectives?: Severity;
}

/** This factory is used to lazily create or update the Program only when necessary. */
export interface ProgramFactory {
    /** Get the CompilerOptions used to create the Program. */
    getCompilerOptions(): ts.CompilerOptions;
    /** This method is called to retrieve the Program on the first use. It should create or update the Program if necessary. */
    getProgram(): ts.Program;
}

class StaticProgramFactory implements ProgramFactory {
    constructor(private program: ts.Program) {}

    public getCompilerOptions() {
        return this.program.getCompilerOptions();
    }

    public getProgram() {
        return this.program;
    }
}

class CachedProgramFactory implements ProgramFactory {
    private program: ts.Program | undefined = undefined;
    private options: ts.CompilerOptions | undefined = undefined;

    constructor(private factory: ProgramFactory) {}

    public getCompilerOptions() {
        return this.options ??= this.factory.getCompilerOptions();
    }

    public getProgram() {
        if (this.program === undefined) {
            this.program = this.factory.getProgram();
            this.options = this.program.getCompilerOptions();
        }
        return this.program;
    }
}

/**
 * Creates a new SourceFile from the updated source.
 *
 * @returns the new `SourceFile` on success or `undefined` to roll back the latest set of changes.
 */
export type UpdateFileCallback = (content: string, range: ts.TextChangeRange) => ts.SourceFile | undefined;

@injectable()
export class Linter {
    constructor(
        private ruleLoader: RuleLoader,
        private logger: MessageHandler,
        private deprecationHandler: DeprecationHandler,
        private filterFactory: FindingFilterFactory,
    ) {}

    public lintFile(
        file: ts.SourceFile,
        config: EffectiveConfiguration,
        programOrFactory?: ProgramFactory | ts.Program,
        options: LinterOptions = {},
    ): ReadonlyArray<Finding> {
        return this.getFindings(
            file,
            config,
            programOrFactory !== undefined && 'getTypeChecker' in programOrFactory
                ? new StaticProgramFactory(programOrFactory)
                : programOrFactory,
            undefined,
            options,
        );
    }

    public lintAndFix(
        file: ts.SourceFile,
        content: string,
        config: EffectiveConfiguration,
        updateFile: UpdateFileCallback,
        iterations: number = 10,
        programFactory?: ProgramFactory,
        processor?: AbstractProcessor,
        options: LinterOptions = {},
        /** Initial set of findings from a cache. If provided, the initial linting is skipped and these findings are used for fixing. */
        findings = this.getFindings(file, config, programFactory, processor, options),
    ): LintAndFixFileResult {
        let totalFixes = 0;
        for (let i = 0; i < iterations; ++i) {
            if (findings.length === 0)
                break;
            const fixes = mapDefined(findings, (f) => f.fix);
            if (fixes.length === 0) {
                log('No fixes');
                break;
            }
            log('Trying to apply %d fixes in %d. iteration', fixes.length, i + 1);
            const fixed = applyFixes(content, fixes);
            log('Applied %d fixes', fixed.fixed);
            let newSource: string;
            let fixedRange: ts.TextChangeRange;
            if (processor !== undefined) {
                const {transformed, changeRange} = processor.updateSource(fixed.result, fixed.range);
                fixedRange = changeRange ?? calculateChangeRange(file.text, transformed);
                newSource = transformed;
            } else {
                newSource = fixed.result;
                fixedRange = fixed.range;
            }
            const updateResult = updateFile(newSource, fixedRange);
            if (updateResult === undefined) {
                log('Rolling back latest fixes and abort linting');
                processor?.updateSource(content, invertChangeRange(fixed.range)); // reset processor state
                break;
            }
            file = updateResult;
            content = fixed.result;
            totalFixes += fixed.fixed;
            findings = this.getFindings(file, config, programFactory, processor, options);
        }
        return {
            content,
            findings,
            fixes: totalFixes,
        };
    }

    // @internal
    public getFindings(
        sourceFile: ts.SourceFile,
        config: EffectiveConfiguration,
        programFactory: ProgramFactory | undefined,
        processor: AbstractProcessor | undefined,
        options: LinterOptions,
    ) {
        // make sure that all rules get the same Program and CompilerOptions for this run
        programFactory &&= new CachedProgramFactory(programFactory);

        let suppressMissingTypeInfoWarning = false;
        log('Linting file %s', sourceFile.fileName);
        if (programFactory !== undefined) {
            const directive = getTsCheckDirective(sourceFile.text);
            if (
                directive !== undefined
                    ? !directive.enabled
                    : /\.jsx?/.test(sourceFile.fileName) && !isCompilerOptionEnabled(programFactory.getCompilerOptions(), 'checkJs')
            ) {
                log('Not using type information for this unchecked file');
                programFactory = undefined;
                suppressMissingTypeInfoWarning = true;
            }
        }
        const rules = this.prepareRules(config, sourceFile, programFactory, suppressMissingTypeInfoWarning);
        let findings;
        if (rules.length === 0) {
            log('No active rules');
            if (options.reportUselessDirectives !== undefined) {
                findings = this.filterFactory
                    .create({sourceFile, getWrappedAst() { return convertAst(sourceFile).wrapped; }, ruleNames: emptyArray})
                    .reportUseless(options.reportUselessDirectives);
                log('Found %d useless directives', findings.length);
            } else {
                findings = emptyArray;
            }
        } else {
            findings = this.applyRules(sourceFile, programFactory, rules, config.settings, options);
        }
        return processor === undefined ? findings : processor.postprocess(findings);
    }

    private prepareRules(
        config: EffectiveConfiguration,
        sourceFile: ts.SourceFile,
        programFactory: ProgramFactory | undefined,
        noWarn: boolean,
    ) {
        const rules: PreparedRule[] = [];
        for (const [ruleName, {options, severity, rulesDirectories, rule}] of config.rules) {
            if (severity === 'off')
                continue;
            const ctor = this.ruleLoader.loadRule(rule, rulesDirectories);
            if (ctor === undefined)
                continue;
            if (ctor.deprecated)
                this.deprecationHandler.handle(
                    DeprecationTarget.Rule,
                    ruleName,
                    typeof ctor.deprecated === 'string' ? ctor.deprecated : undefined,
                );
            if (programFactory === undefined && ctor.requiresTypeInformation) {
                if (noWarn) {
                    log('Rule %s requires type information', ruleName);
                } else {
                    this.logger.warn(`Rule '${ruleName}' requires type information.`);
                }
                continue;
            }
            if (ctor.supports !== undefined) {
                const supports = ctor.supports(sourceFile, {
                    get program() { return programFactory && programFactory.getProgram(); },
                    get compilerOptions() { return programFactory && programFactory.getCompilerOptions(); },
                    options,
                    settings: config.settings,
                });
                if (supports !== true) {
                    if (!supports) {
                        log(`Rule %s does not support this file`, ruleName);
                    } else {
                        log(`Rule %s does not support this file: %s`, ruleName, supports);
                    }
                    continue;
                }
            }
            rules.push({ruleName, options, severity, ctor});
        }
        return rules;
    }

    private applyRules(
        sourceFile: ts.SourceFile,
        programFactory: ProgramFactory | undefined,
        rules: PreparedRule[],
        settings: Map<string, any>,
        options: LinterOptions,
    ) {
        const result: Finding[] = [];
        let findingFilter: FindingFilter | undefined;
        let ruleName: string;
        let severity: Severity;
        let ctor: RuleConstructor;
        let convertedAst: ConvertedAst | undefined;

        const getFindingFilter = () => {
            return findingFilter ??= this.filterFactory.create({sourceFile, getWrappedAst, ruleNames: rules.map((r) => r.ruleName)});
        };

        const context: { -readonly [K in keyof RuleContext]: RuleContext[K] } = {
            getFlatAst,
            getWrappedAst,
            get program() { return programFactory?.getProgram(); },
            get compilerOptions() { return programFactory?.getCompilerOptions(); },
            sourceFile,
            settings,
            addFinding: (pos, end, message, fix, codeActions) => {
                const finding: Finding = {
                    ruleName,
                    severity,
                    message,
                    start: {
                        position: pos,
                        ...ts.getLineAndCharacterOfPosition(sourceFile, pos),
                    },
                    end: {
                        position: end,
                        ...ts.getLineAndCharacterOfPosition(sourceFile, end),
                    },
                    fix: normalizeFix(fix),
                    codeActions: arrayify(codeActions, normalizeCodeAction),
                };
                if (getFindingFilter().filter(finding))
                    result.push(finding);
            },
            options: undefined,
        };

        for ({ruleName, severity, ctor, options: context.options} of rules) {
            log('Executing rule %s', ruleName);
            new ctor(context).apply();
        }

        log('Found %d findings', result.length);
        if (options.reportUselessDirectives !== undefined) {
            const useless = getFindingFilter().reportUseless(options.reportUselessDirectives);
            log('Found %d useless directives', useless.length);
            result.push(...useless);
        }
        return result;

        function getFlatAst() {
            return (convertedAst ??= convertAst(sourceFile)).flat;
        }
        function getWrappedAst() {
            return (convertedAst ??= convertAst(sourceFile)).wrapped;
        }
    }
}

interface PreparedRule {
    ctor: RuleConstructor;
    options: any;
    ruleName: string;
    severity: Severity;
}

function normalizeFix(fixOrReplacements: OneOrMany<Replacement> | CodeAction | undefined): CodeAction | undefined {
    if (fixOrReplacements === undefined)
        return;
    if ('description' in fixOrReplacements)
        return normalizeCodeAction(fixOrReplacements);
    fixOrReplacements = arrayify(fixOrReplacements, nonEmptyReplacement);
    return fixOrReplacements && {
        description: 'auto fix',
        replacements: fixOrReplacements,
    };
}

function normalizeCodeAction(codeAction: CodeAction): CodeAction | undefined {
    const replacements = mapDefined(codeAction.replacements, nonEmptyReplacement);
    // tslint:disable-next-line:object-shorthand-properties-first
    return replacements.length === 0 ? undefined : {description: codeAction.description, replacements};
}

function nonEmptyReplacement(replacement: Replacement): Replacement | undefined {
    return replacement.start !== replacement.end || replacement.text !== '' ? replacement : undefined;
}

function arrayify<T>(maybeArr: OneOrMany<T> | undefined, map: (v: T) => T | undefined): ReadonlyArray<T> | undefined {
    if (maybeArr === undefined)
        return;
    if (!Array.isArray(maybeArr)) {
        maybeArr = map(<T>maybeArr);
        return maybeArr === undefined ? undefined : [maybeArr];
    }
    maybeArr = mapDefined(maybeArr, map);
    return maybeArr.length === 0 ? undefined : maybeArr;
}
