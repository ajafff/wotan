import test from 'ava';
import * as TSLint from 'tslint';
import {Formatter as CheckstyleFormatter} from 'tslint/lib/formatters/checkstyleFormatter'; // tslint:disable-line:no-submodule-imports
import { wrapTslintFormatter } from '../src';
import { Replacement } from '@fimbul/ymir';

test('returns expected output', (t) => {
    testFormatter(TSLint.Formatters.FileslistFormatter, `/bar.ts
/baz.ts`);
    testFormatter(TSLint.Formatters.ProseFormatter, `Fixed 2 error(s) in /foo.ts
Fixed 1 error(s) in /baz.ts

ERROR: /bar.ts:1:1 - message
WARNING: /bar.ts:1:1 - hint
WARNING: /baz.ts:1:1 - a`);
    testFormatter(CheckstyleFormatter, '<?xml version="1.0" encoding="utf-8"?><checkstyle version="4.3">'
        + '<file name="/foo.ts"></file>'
        + '<file name="/bar.ts">'
            + '<error line="1" column="1" severity="error" message="message" source="failure.tslint.foo" />'
            + '<error line="1" column="1" severity="warning" message="hint" source="failure.tslint.bar" />'
        + '</file>'
        + '<file name="/baz.ts"><error line="1" column="1" severity="warning" message="a" source="failure.tslint.rule" /></file>'
        + '</checkstyle>');
    function testFormatter(ctor: TSLint.FormatterConstructor, expected: string) {
        const formatter = wrapTslintFormatter(ctor);
        const f = new formatter();
        t.is(f.format('/foo.ts', {fixes: 2, findings: [], content: ''}), undefined);
        t.is(
            f.format(
                '/bar.ts',
                {
                    fixes: 0,
                    findings: [
                        {
                            ruleName: 'foo',
                            severity: 'error',
                            message: 'message',
                            start: {position: 0, line: 0, character: 0},
                            end: {position: 0, line: 0, character: 0},
                            fix: undefined,
                            codeActions: undefined,
                        },
                        {
                            ruleName: 'bar',
                            severity: 'suggestion',
                            message: 'hint',
                            start: {position: 0, line: 0, character: 0},
                            end: {position: 0, line: 0, character: 0},
                            fix: undefined,
                            codeActions: undefined,
                        },
                    ],
                    content: '',
                },
            ),
            undefined,
        );
        t.is(
            f.format(
                '/baz.ts',
                {
                    fixes: 1,
                    findings: [{
                        ruleName: 'rule',
                        severity: 'warning',
                        message: 'a',
                        start: {position: 0, line: 0, character: 1},
                        end: {position: 1, line: 0, character: 1},
                        fix: {description: 'auto fix', replacements: [Replacement.delete(0, 1)]},
                        codeActions: undefined,
                    }],
                    content: 'a',
                },
            ),
            undefined,
        );
        t.is(f.flush!(), expected);
    }
});
