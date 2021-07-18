import 'reflect-metadata';
import test from 'ava';
import { Container, injectable } from 'inversify';
import {
    CacheFactory,
    RuleLoaderHost,
    MessageHandler,
    TypedRule,
    RuleConstructor,
    AbstractRule,
    DeprecationHandler,
    EffectiveConfiguration,
    Finding,
    Replacement,
    FindingFilterFactory,
    LineSwitchParser,
    AbstractProcessor,
    LintAndFixFileResult,
    predicate,
} from '@fimbul/ymir';
import { DefaultCacheFactory } from '../src/services/default/cache-factory';
import { RuleLoader } from '../src/services/rule-loader';
import { Linter } from '../src/linter';
import * as ts from 'typescript';
import { DefaultDeprecationHandler } from '../src/services/default/deprecation-handler';
import { LineSwitchFilterFactory, DefaultLineSwitchParser } from '../src/services/default/line-switches';
import { calculateChangeRange } from '../src/utils';

class MyTypedRule extends TypedRule {
    public apply() {
        this.addFinding(0, 0, 'message');
    }
}
class MyDeprecatedRule extends AbstractRule {
    public static deprecated: boolean | string = true;
    public apply() {
        this.addFinding(0, 0, 'message', []);
    }
}
class MyCustomDeprecatedRule extends AbstractRule {
    public static deprecated = 'Use that other rule instead.';
    public apply() {
        this.addFinding(0, 0, 'message', [Replacement.append(0, '\uFEFF')]);
    }
}
@predicate((_, {program, compilerOptions}) => program !== undefined && compilerOptions !== undefined)
class ProgramAccessRule extends TypedRule {
    public apply() {
        this.addFinding(0, 0, String(this.program.getCompilerOptions() === this.context.compilerOptions));
    }
}

test('Linter', (t) => {
    const warnings: string[] = [];
    const container = new Container();
    container.bind(CacheFactory).to(DefaultCacheFactory);
    container.bind(RuleLoader).toSelf();
    container.bind(DeprecationHandler).to(DefaultDeprecationHandler);
    container.bind(FindingFilterFactory).to(LineSwitchFilterFactory);
    container.bind(LineSwitchParser).to(DefaultLineSwitchParser);
    container.bind(MessageHandler).toConstantValue({
        log() {
            throw new Error('not implemented');
        },
        warn(message) {
            warnings.push(message);
        },
        error() {
            throw new Error('not implemented');
        },
    });
    @injectable()
    class Host implements RuleLoaderHost {
        public loadCoreRule(name: string): RuleConstructor | undefined {
            switch (name) {
                case 'typed':
                    return <RuleConstructor>MyTypedRule;
                case 'deprecated':
                    return MyDeprecatedRule;
                case 'deprecation-message':
                    return MyCustomDeprecatedRule;
                case 'program-access':
                    return <RuleConstructor>ProgramAccessRule;
            }
            return;
        }

        public loadCustomRule(): undefined {
            return;
        }
    }
    container.bind(RuleLoaderHost).to(Host);

    const sourceFile = ts.createSourceFile('/foo.ts', 'foo;', ts.ScriptTarget.ESNext);
    const linter = container.resolve(Linter);
    t.deepEqual(
        linter.lintFile(sourceFile, {
            settings: new Map(),
            rules: new Map<string, EffectiveConfiguration.RuleConfig>([
                ['my/alias', {severity: 'warning', rulesDirectories: undefined, options: undefined, rule: 'typed'}],
            ]),
        }),
        [],
    );
    t.deepEqual(warnings, ["Rule 'my/alias' requires type information."]);

    t.deepEqual(
        linter.lintFile(sourceFile, {
            settings: new Map(),
            rules: new Map<string, EffectiveConfiguration.RuleConfig>([
                ['my/alias', {severity: 'off', rulesDirectories: undefined, options: undefined, rule: 'deprecated'}],
            ]),
        }),
        [],
    );
    t.is(warnings.length, 1);

    t.deepEqual<ReadonlyArray<Finding>>(
        linter.lintFile(sourceFile, {
            settings: new Map(),
            rules: new Map<string, EffectiveConfiguration.RuleConfig>([
                ['my/alias', {severity: 'warning', rulesDirectories: undefined, options: undefined, rule: 'deprecated'}],
            ]),
        }),
        [{
            ruleName: 'my/alias',
            fix: undefined,
            message: 'message',
            severity: 'warning',
            start: {position: 0, line: 0, character: 0},
            end: {position: 0, line: 0, character: 0},
            codeActions: undefined,
        }],
    );
    t.is(warnings.length, 2);
    t.is(warnings[1], "Rule 'my/alias' is deprecated.");

    t.deepEqual<ReadonlyArray<Finding>>(
        linter.lintFile(sourceFile, {
            settings: new Map(),
            rules: new Map<string, EffectiveConfiguration.RuleConfig>([
                ['my/other/alias', {severity: 'error', rulesDirectories: undefined, options: undefined, rule: 'deprecation-message'}],
            ]),
        }),
        [{
            ruleName: 'my/other/alias',
            fix: {
                description: 'auto fix',
                replacements: [{start: 0, end: 0, text: '\uFEFF'}],
            },
            message: 'message',
            severity: 'error',
            start: {position: 0, line: 0, character: 0},
            end: {position: 0, line: 0, character: 0},
            codeActions: undefined,
        }],
    );
    t.is(warnings.length, 3);
    t.is(warnings[2], "Rule 'my/other/alias' is deprecated: Use that other rule instead.");

    t.deepEqual<ReadonlyArray<Finding>>(
        linter.lintFile(sourceFile, {
            settings: new Map(),
            rules: new Map<string, EffectiveConfiguration.RuleConfig>([
                ['my/other/alias', {severity: 'error', rulesDirectories: undefined, options: undefined, rule: 'non-existent'}],
            ]),
        }),
        [],
    );
    t.is(warnings.length, 4);
    t.is(warnings[3], "Could not find core rule 'non-existent'.");

    t.deepEqual<ReadonlyArray<Finding>>(
        linter.lintFile(sourceFile, {
            settings: new Map(),
            rules: new Map<string, EffectiveConfiguration.RuleConfig>([
                ['my/other/alias', {severity: 'error', rulesDirectories: ['/foo'], options: undefined, rule: 'non-existent'}],
            ]),
        }),
        [],
    );
    t.is(warnings.length, 5);
    t.is(warnings[4], "Could not find rule 'non-existent' in '/foo'.");

    {
        const program = createFakeProgram(sourceFile, {});
        let getCompilerOptionsCalled = false;
        let getProgramCalled = false;
        t.deepEqual<ReadonlyArray<Finding>>(
            linter.lintFile(
                sourceFile,
                {
                    settings: new Map(),
                    rules: new Map<string, EffectiveConfiguration.RuleConfig>([
                        ['rule-name', {severity: 'error', rulesDirectories: undefined, options: undefined, rule: 'program-access'}],
                    ]),
                },
                {
                    getCompilerOptions() {
                        t.is(getCompilerOptionsCalled, false, 'should not be called multiple times');
                        getCompilerOptionsCalled = true;
                        return program.getCompilerOptions();
                    },
                    getProgram() {
                        t.is(getProgramCalled, false, 'should not be called multiple times');
                        getProgramCalled = true;
                        return program;
                    },
                },
            ),
            [{
                ruleName: 'rule-name',
                fix: undefined,
                message: 'true',
                severity: 'error',
                start: {position: 0, line: 0, character: 0},
                end: {position: 0, line: 0, character: 0},
                codeActions: undefined,
            }],
        );
        t.is(warnings.length, 5);

        t.deepEqual<ReadonlyArray<Finding>>(
            linter.lintFile(
                sourceFile,
                {
                    settings: new Map(),
                    rules: new Map<string, EffectiveConfiguration.RuleConfig>([
                        ['rule-name', {severity: 'error', rulesDirectories: undefined, options: undefined, rule: 'program-access'}],
                    ]),
                },
                program,
            ),
            [{
                ruleName: 'rule-name',
                fix: undefined,
                message: 'true',
                severity: 'error',
                start: {position: 0, line: 0, character: 0},
                end: {position: 0, line: 0, character: 0},
                codeActions: undefined,
            }],
        );
        t.is(warnings.length, 5);
    }

    t.deepEqual<ReadonlyArray<Finding>>(
        linter.lintFile(ts.createSourceFile('foo.js', 'foo;', ts.ScriptTarget.ESNext), {
            settings: new Map(),
            rules: new Map<string, EffectiveConfiguration.RuleConfig>([
                ['my/typed', {severity: 'error', rulesDirectories: undefined, options: undefined, rule: 'typed'}],
            ]),
        }),
        [],
    );
    t.is(warnings.length, 6, 'Should emit a warning about missing type information in an unchecked JS file');
    t.is(warnings[5], "Rule 'my/typed' requires type information.");

    function lintWithProgram(file: ts.SourceFile, options: ts.CompilerOptions, config: EffectiveConfiguration) {
        return linter.lintFile(file, config, createFakeProgram(file, options));
    }

    t.deepEqual<ReadonlyArray<Finding>>(
        lintWithProgram(ts.createSourceFile('foo.js', 'foo;', ts.ScriptTarget.ESNext), {allowJs: true}, {
            settings: new Map(),
            rules: new Map<string, EffectiveConfiguration.RuleConfig>([
                ['typed', {severity: 'error', rulesDirectories: undefined, options: undefined, rule: 'typed'}],
            ]),
        }),
        [],
    );
    t.is(warnings.length, 6, "Shouldn't emit a warning if type information was discarded in an unchecked JS file");

    t.deepEqual<ReadonlyArray<Finding>>(
        lintWithProgram(ts.createSourceFile('foo.js', '// @ts-nocheck\nfoo;', ts.ScriptTarget.ESNext), {allowJs: true, checkJs: true}, {
            settings: new Map(),
            rules: new Map<string, EffectiveConfiguration.RuleConfig>([
                ['typed', {severity: 'error', rulesDirectories: undefined, options: undefined, rule: 'typed'}],
            ]),
        }),
        [],
    );
    t.is(warnings.length, 6, "Shouldn't emit a warning if type information was discarded in an unchecked JS file");

    t.deepEqual<ReadonlyArray<Finding>>(
        lintWithProgram(ts.createSourceFile('foo.ts', '// @ts-nocheck\nfoo;', ts.ScriptTarget.ESNext), {}, {
            settings: new Map(),
            rules: new Map<string, EffectiveConfiguration.RuleConfig>([
                ['typed', {severity: 'error', rulesDirectories: undefined, options: undefined, rule: 'typed'}],
            ]),
        }),
        [],
    );
    t.is(warnings.length, 6, "Shouldn't emit a warning if type information was discarded in an unchecked TS file");

    t.deepEqual<ReadonlyArray<Finding>>(
        lintWithProgram(ts.createSourceFile('foo.js', 'foo;', ts.ScriptTarget.ESNext), {allowJs: true, checkJs: true}, {
            settings: new Map(),
            rules: new Map<string, EffectiveConfiguration.RuleConfig>([
                ['typed', {severity: 'error', rulesDirectories: undefined, options: undefined, rule: 'typed'}],
            ]),
        }),
        [{
            ruleName: 'typed',
            fix: undefined,
            message: 'message',
            severity: 'error',
            start: {position: 0, line: 0, character: 0},
            end: {position: 0, line: 0, character: 0},
            codeActions: undefined,
        }],
        'Should lint checked JS file with type information',
    );
    t.is(warnings.length, 6);

    t.deepEqual<ReadonlyArray<Finding>>(
        lintWithProgram(ts.createSourceFile('foo.js', '// @ts-check\nfoo;', ts.ScriptTarget.ESNext), {allowJs: true}, {
            settings: new Map(),
            rules: new Map<string, EffectiveConfiguration.RuleConfig>([
                ['typed', {severity: 'error', rulesDirectories: undefined, options: undefined, rule: 'typed'}],
            ]),
        }),
        [{
            ruleName: 'typed',
            fix: undefined,
            message: 'message',
            severity: 'error',
            start: {position: 0, line: 0, character: 0},
            end: {position: 0, line: 0, character: 0},
            codeActions: undefined,
        }],
        'Should lint checked JS file with type information',
    );
    t.is(warnings.length, 6);

    class Processor extends AbstractProcessor {
        public preprocess(): never {
            throw new Error('should not be called');
        }
        public postprocess(findings: ReadonlyArray<Finding>) {
            return findings;
        }
        public updateSource(newSource: string, changeRange: ts.TextChangeRange) {
            t.deepEqual(changeRange, calculateChangeRange(this.source, newSource));
            this.source = newSource;
            return {
                changeRange,
                transformed: newSource,
            };
        }
        public getSource() {
            return this.source;
        }
    }
    const processor = new Processor({
        settings: new Map(),
        source: sourceFile.text,
        sourceFileName: sourceFile.fileName,
        targetFileName: sourceFile.fileName,
    });
    t.deepEqual<LintAndFixFileResult>(
        linter.lintAndFix(
            sourceFile,
            sourceFile.text,
            {
                settings: new Map(),
                rules: new Map<string, EffectiveConfiguration.RuleConfig>([
                    ['rule', {severity: 'warning', rulesDirectories: undefined, options: undefined, rule: 'deprecation-message'}],
                ]),
            },
            () => undefined,
            undefined,
            undefined,
            processor,
        ),
        {
            content: sourceFile.text,
            fixes: 0,
            findings: [{
                ruleName: 'rule',
                fix: {
                    description: 'auto fix',
                    replacements: [{start: 0, end: 0, text: '\uFEFF'}],
                },
                message: 'message',
                severity: 'warning',
                start: {position: 0, line: 0, character: 0},
                end: {position: 0, line: 0, character: 0},
                codeActions: undefined,
            }],
        },
    );
    t.is(processor.getSource(), sourceFile.text, "didn't correctly reset the processor");
});

function createFakeProgram(sourceFile: ts.SourceFile, options: ts.CompilerOptions) {
    return ts.createProgram([sourceFile.fileName], {...options, noLib: true, noEmit: true}, {
        getSourceFile(fileName) {
            return fileName === sourceFile.fileName ? sourceFile : undefined;
        },
        directoryExists() { return false; },
        fileExists() { return false; },
        getCanonicalFileName(f) { return f; },
        getCurrentDirectory: process.cwd,
        getDirectories() { return []; },
        getDefaultLibFileName() { return ts.getDefaultLibFileName(options); },
        getNewLine() { return '\n'; },
        readFile(): undefined { return; },
        useCaseSensitiveFileNames() { return true; },
        writeFile() {},
    });
}
