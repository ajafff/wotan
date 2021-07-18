import test, { ExecutionContext } from 'ava';
import { Finding, Severity, Replacement, AbstractFormatter, FileSummary, FormatterConstructor, LintResult, CodeAction } from '@fimbul/ymir';
import { Formatter as JsonFormatter} from '../src/formatters/json';
import { Formatter as StylishFormatter } from '../src/formatters/stylish';
import * as chalk from 'chalk';
import * as path from 'path';

test.before(() => {
    (<any>chalk).level = 1;
});

function createFinding(
    name: string,
    severity: Severity,
    message: string,
    start: number,
    end: number,
    fix?: Replacement[],
    codeActions?: CodeAction[],
): Finding {
    return {
        severity,
        message,
        codeActions,
        ruleName: name,
        start: {
            position: start,
            line: 0,
            character: start,
        },
        end: {
            position: end,
            line: 0,
            character: end,
        },
        fix: fix && { description: 'auto fix', replacements: fix },
    };
}

const summary = new Map<string, FileSummary>();
summary.set('/some/directory/a.ts', {
    content: '',
    findings: [],
    fixes: 0,
});
summary.set('/some/other/directory/b.ts', {
    content: 'foo = bar',
    findings: [
        createFinding('foo', 'warning', 'no foo', 0, 3, [Replacement.delete(0, 3)]),
        createFinding('bar', 'error', 'no bar', 6, 9, [Replacement.replace(6, 9, 'baz')]),
        createFinding('equals', 'error', 'no equals', 4, 5, undefined, [
            CodeAction.create('Convert assignment to comparison', Replacement.append(5, '==')),
            CodeAction.create('Remove all the things', [Replacement.delete(1, 3), Replacement.delete(7, 9)]),
        ]),
    ],
    fixes: 1,
});
summary.set('/some/directory/c.ts', {
    content: '',
    findings: [],
    fixes: 3,
});
summary.set('/my/project/a.ts', {
    content: 'debugger;',
    findings: [
        createFinding('trailing-newline', 'error', 'missing trailing newline', 9, 9, [Replacement.append(9, '\n')]),
    ],
    fixes: 0,
});

const emptySummary: LintResult = new Map();
const noFindingSummary: LintResult = new Map([['/some/file.js', {content: '', findings: [], fixes: 0}]]);
const fixedSummary: LintResult = new Map([['/project/fixed.js', {content: '', findings: [], fixes: 1}]]);
const fixableSummary: LintResult = new Map([
    [
        '/dir/fixableError.ts',
        {content: 'debugger;', findings: [createFinding('no-debugger', 'error', 'debugger', 0, 9, [Replacement.delete(0, 9)])], fixes: 0},
    ],
]);
const warningSummary: LintResult = new Map([
    [
        '/dir/warnings.ts',
        {content: 'a', findings: [createFinding('a', 'warning', 'a', 0, 0)], fixes: 0},
    ],
    [
        'C:/dir/warnings2.ts',
        {content: 'b', findings: [createFinding('b', 'warning', 'b', 0, 0)], fixes: 0},
    ],
]);
const bomSummary: LintResult = new Map<string, FileSummary>([[
    '/dir/warnings.ts',
    {
        content: '\uFEFFa\nb',
        findings: [
            {
                severity: 'error',
                message: 'BOM',
                ruleName: 'bom',
                start: {
                    position: 0,
                    line: 0,
                    character: 0,
                },
                end: {
                    position: 1,
                    line: 0,
                    character: 1,
                },
                fix: undefined,
                codeActions: undefined,
            },
            {
                severity: 'warning',
                message: 'a',
                ruleName: 'a',
                start: {
                    position: 1,
                    line: 0,
                    character: 1,
                },
                end: {
                    position: 2,
                    line: 0,
                    character: 2,
                },
                fix: undefined,
                codeActions: undefined,
            },
            {
                severity: 'warning',
                message: 'b',
                ruleName: 'a',
                start: {
                    position: 3,
                    line: 1,
                    character: 0,
                },
                end: {
                    position: 4,
                    line: 1,
                    character: 1,
                },
                fix: undefined,
                codeActions: undefined,
            },
            {
                severity: 'warning',
                message: 'EOF',
                ruleName: 'eof',
                start: {
                    position: 4,
                    line: 1,
                    character: 1,
                },
                end: {
                    position: 4,
                    line: 1,
                    character: 1,
                },
                fix: undefined,
                codeActions: undefined,
            },
        ],
        fixes: 0,
    },
]]);

function testFormatter(formatterCtor: FormatterConstructor, t: ExecutionContext, transform?: (s: string) => string) {
    testOutput(emptySummary, 'empty');
    testOutput(noFindingSummary, 'success');
    testOutput(fixedSummary, 'fixed');
    testOutput(fixableSummary, 'fixable');
    testOutput(warningSummary, 'warnings');
    testOutput(summary, 'mixed');
    testOutput(bomSummary, 'bom');

    function testOutput(lintResult: LintResult, name: string) {
        const output = format(lintResult, new formatterCtor());
        t.snapshot(transform === undefined ? output : transform(output), {id: `${t.title} ${name}`});
    }
}

function format(lintResult: LintResult, formatter: AbstractFormatter): string {
    let result = formatter.prefix !== undefined ? formatter.prefix + '\n' : '';
    for (const [fileName, fileResult] of lintResult) {
        const formatted = formatter.format(fileName, fileResult);
        if (formatted !== undefined)
            result += formatted + '\n';
    }
    if (formatter.flush !== undefined) {
        const formatted = formatter.flush();
        if (formatted !== undefined)
            result += formatted + '\n';
    }
    return result;
}

test('JSON', (t) => {
    testFormatter(JsonFormatter, t);
});

test('Stylish', (t) => {
    const lines = format(warningSummary, new StylishFormatter()).split('\n');
    t.true(lines[0].startsWith(`\u001b[4m${path.normalize('/dir/warnings.ts')}\u001b[24m`));
    t.true(lines[3].startsWith(`\u001b[4m${path.normalize('C:/dir/warnings2.ts')}\u001b[24m`));
    testFormatter(StylishFormatter, t, (output) => {
        return output
            .split('\n')
            .map((line) => line.startsWith('\u001b[4m') ? line.replace(/\\/g, '/') : line)
            .join('\n');
    });
});
