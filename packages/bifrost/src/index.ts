import {
    AbstractRule,
    RuleContext,
    AbstractFormatter,
    FileSummary,
    RuleConstructor,
    FormatterConstructor,
    Replacement,
    typescriptOnly,
    CodeAction,
    OneOrMany,
} from '@fimbul/ymir';
import * as TSLint from 'tslint';
import * as ts from 'typescript';
import getCaller = require('get-caller-file');
import * as path from 'path';
import { convertAst } from 'tsutils';
import { __decorate } from 'tslib';

// tslint:disable-next-line:naming-convention
export function wrapTslintRule(Rule: TSLint.RuleConstructor, name: string = inferName(Rule)): RuleConstructor {
    class R extends AbstractRule {
        public static requiresTypeInformation =
            !!(Rule.metadata && Rule.metadata.requiresTypeInfo) ||
            Rule.prototype instanceof TSLint.Rules.TypedRule;

        public static deprecated = Rule.metadata && typeof Rule.metadata.deprecationMessage === 'string'
            ? Rule.metadata.deprecationMessage || true // empty deprecation message is coerced to true
            : false;

        private delegate: TSLint.IRule;

        constructor(context: RuleContext) {
            super(context);
            this.delegate = new Rule({
                ruleArguments: TSLint.Utils.arrayify(context.options),
                ruleSeverity: 'error',
                ruleName: name,
                disabledIntervals: [],
            });
        }

        public apply() {
            if (!this.delegate.isEnabled())
                return;
            let result: TSLint.RuleFailure[];
            if (TSLint.isTypedRule(this.delegate) && this.program !== undefined) {
                result = this.delegate.applyWithProgram(this.sourceFile, this.program);
            } else {
                result = this.delegate.apply(this.sourceFile);
            }
            const {fileName} = this.sourceFile;
            for (const failure of result) {
                if (failure.getFileName() !== fileName)
                    throw new Error(`Adding findings for a different SourceFile is not supported. Expected '${
                        fileName}' but received '${failure.getFileName()}' from rule '${this.delegate.getOptions().ruleName}'.`);
                this.addFinding(
                    failure.getStartPosition().getPosition(),
                    failure.getEndPosition().getPosition(),
                    failure.getFailure(),
                    arrayify(failure.getFix()).map((r) => ({start: r.start, end: r.end, text: r.text})),
                );
            }
        }
    }
    return Rule.metadata && Rule.metadata.typescriptOnly ? __decorate([typescriptOnly], R) : R;
}

function inferName(Rule: TSLint.RuleConstructor): string { // tslint:disable-line:naming-convention
    if (Rule.metadata !== undefined && Rule.metadata.ruleName)
        return Rule.metadata.ruleName;
    const caller = getCaller(3);
    return path.basename(caller, path.extname(caller));
}

export function wrapTslintFormatter(Formatter: TSLint.FormatterConstructor): FormatterConstructor { // tslint:disable-line:naming-convention
    return class extends AbstractFormatter {
        private fileNames: string[] = [];
        private failures: TSLint.RuleFailure[] = [];
        private fixed: TSLint.RuleFailure[] = [];
        private delegate: TSLint.IFormatter;

        constructor() {
            super();
            this.delegate = new Formatter();
        }

        public format(fileName: string, summary: FileSummary): undefined {
            this.fileNames.push(fileName);
            let sourceFile: ts.SourceFile | undefined;
            for (let i = 0; i < summary.fixes; ++i)
                this.fixed.push(new TSLint.RuleFailure(getSourceFile(), 0, 0, '', '', TSLint.Replacement.appendText(0, '')));
            if (summary.findings.length === 0)
                return;
            this.failures.push(
                ...summary.findings.map((f) => {
                    const failure = new TSLint.RuleFailure(
                        getSourceFile(),
                        f.start.position,
                        f.end.position,
                        f.message,
                        f.ruleName,
                        f.fix?.replacements.map(convertToTslintReplacement));
                    failure.setRuleSeverity(f.severity === 'suggestion' ? 'warning' : f.severity);
                    return failure;
                }),
            );
            return;

            function getSourceFile() {
                return sourceFile ??= ts.createSourceFile(fileName, summary.content, ts.ScriptTarget.Latest);
            }
        }

        public flush() {
            return this.delegate.format(this.failures, this.fixed, this.fileNames).trim();
        }
    };
}

// tslint:disable-next-line:naming-convention
export function wrapRuleForTslint<T extends RuleContext>(Rule: RuleConstructor<T>): TSLint.RuleConstructor {
    const metadata: TSLint.IRuleMetadata = {
        ruleName: 'who-cares',
        typescriptOnly: false,
        description: '',
        options: undefined,
        optionsDescription: '',
        type: 'functionality',
        deprecationMessage: !Rule.deprecated ? undefined : Rule.deprecated === true ? '' : Rule.deprecated,
    };

    function apply(options: TSLint.IOptions, sourceFile: ts.SourceFile, program?: ts.Program): TSLint.RuleFailure[] {
        const args = options.ruleArguments.length < 2 ? options.ruleArguments[0] : options.ruleArguments;
        const failures: TSLint.RuleFailure[] = [];
        const context: RuleContext = {
            sourceFile,
            program,
            compilerOptions: program && program.getCompilerOptions(),
            options: args,
            settings: new Map(),
            getFlatAst() {
                return convertAst(sourceFile).flat;
            },
            getWrappedAst() {
                return convertAst(sourceFile).wrapped;
            },
            addFinding(start, end, message, fix) {
                failures.push(
                    new TSLint.RuleFailure(
                        sourceFile,
                        start,
                        end,
                        message,
                        options.ruleName,
                        convertFixToTslintReplacements(fix),
                    ),
                );
            },
        };
        if (Rule.supports === undefined || Rule.supports(sourceFile, context) === true)
            new Rule(<T>context).apply();
        return failures;
    }

    if (Rule.requiresTypeInformation)
        return class extends TSLint.Rules.TypedRule {
            public static metadata = metadata;

            public applyWithProgram(sourceFile: ts.SourceFile, program: ts.Program) {
                return apply(this.getOptions(), sourceFile, program);
            }
        };
    return class extends TSLint.Rules.OptionallyTypedRule {
        public static metadata = metadata;

        public apply(sourceFile: ts.SourceFile) {
            return apply(this.getOptions(), sourceFile);
        }
        public applyWithProgram(sourceFile: ts.SourceFile, program: ts.Program) {
            return apply(this.getOptions(), sourceFile, program);
        }
    };
}

function convertFixToTslintReplacements(fix: CodeAction | OneOrMany<Replacement> | undefined): TSLint.Replacement[] | undefined {
    return fix === undefined
        ? undefined
        : ('description' in fix ? fix.replacements : arrayify(fix)).map(convertToTslintReplacement);
}

function convertToTslintReplacement(r: Replacement) {
    return new TSLint.Replacement(r.start, r.end - r.start, r.text);
}

function arrayify<T>(maybeArr: T | ReadonlyArray<T> | undefined): ReadonlyArray<T> {
    return Array.isArray(maybeArr)
        ? maybeArr
        : maybeArr === undefined
            ? []
            : [maybeArr];
}
