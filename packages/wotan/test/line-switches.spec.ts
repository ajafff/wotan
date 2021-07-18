import 'reflect-metadata';
import test from 'ava';
import * as ts from 'typescript';
import { convertAst } from 'tsutils';
import { LineSwitchFilterFactory, DefaultLineSwitchParser } from '../src/services/default/line-switches';
import { Finding } from '@fimbul/ymir';

test('getDisabledRanges', (t) => {
    const source = `#! shebang
// wotan-disable
"/* wotan-enable */" /*wotan-enable*/;
let foo /* wotan-disable-line */ = true;
//wotan-disable-line foobaz`;
    const sourceFile = ts.createSourceFile('/foo.ts', source, ts.ScriptTarget.ESNext);
    const {wrapped} = convertAst(sourceFile);

    const lineSwitchService = new LineSwitchFilterFactory(new DefaultLineSwitchParser());
    t.deepEqual(
        lineSwitchService.getDisabledRanges({sourceFile, ruleNames: ['foobar'], getWrappedAst: () => wrapped}),
        new Map([['foobar', [
            {
                pos: 11,
                end: 49,
            },
            {
                pos: 67,
                end: 108,
            },
        ]]]),
    );

    const filter = lineSwitchService.create({sourceFile, ruleNames: ['foobar'], getWrappedAst: () => wrapped});
    t.true(filter.filter(createFinding('foobaz', 0, 100)));
    t.false(filter.filter(createFinding('foobar', 0, 100)));
    t.true(filter.filter(createFinding('foobar', 0, 11)));
    t.false(filter.filter(createFinding('foobar', 0, 12)));
    t.false(filter.filter(createFinding('foobar', 48, 50)));
    t.true(filter.filter(createFinding('foobar', 49, 50)));

    t.deepEqual(
        new LineSwitchFilterFactory({
            parse(context) {
                t.is(context.getCommentAtPosition(-1), undefined); // should not throw here
                return [
                    { // is discarded because unnecessary for 'foo' and no matching rule 'bar'
                        rules: [{predicate: 'foo'}, {predicate: 'bar'}],
                        enable: true,
                        pos: 0,
                        end: 0,
                        location: {pos: 0, end: 1},
                    },
                    { // ignored because it's out of range
                        rules: [{predicate: 'baz'}],
                        enable: false,
                        pos: -10,
                        end: -5,
                        location: {pos: 0, end: 1},
                    },
                    {
                        rules: [{predicate: (rule) => rule === 'baz'}],
                        enable: false,
                        pos: 5,
                        end: 10,
                        location: {pos: 5, end: 6},
                    },
                    {
                        rules: [{predicate: 'baz'}],
                        enable: false,
                        pos: 15,
                        end: undefined,
                        location: {pos: 15, end: 16},
                    },
                    {
                        rules: [{predicate: 'baz'}],
                        enable: true,
                        pos: 20,
                        end: 25,
                        location: {pos: 20, end: 21},
                    },
                    { // has no effect as the rule is already disabled
                        rules: [{predicate: 'baz'}],
                        enable: false,
                        pos: 30,
                        end: 35,
                        location: {pos: 30, end: 31},
                    },
                    { // ignored because out of range
                        rules: [{predicate: 'baz'}],
                        enable: false,
                        pos: Infinity,
                        end: undefined,
                        location: {pos: 1000, end: 1001},
                    },
                ];
            },
        }).getDisabledRanges({sourceFile, ruleNames: ['foo', 'baz'], getWrappedAst: () => wrapped}),
        new Map([['baz', [{pos: 5, end: 10}, {pos: 15, end: 20}, {pos: 25, end: Infinity}]]]),
    );

    function createFinding(ruleName: string, start: number, end: number): Finding {
        return {
            ruleName,
            message: '',
            severity: 'error',
            start: {
                position: start,
                ...ts.getLineAndCharacterOfPosition(sourceFile, start),
            },
            end: {
                position: end,
                ...ts.getLineAndCharacterOfPosition(sourceFile, end),
            },
            fix: undefined,
            codeActions: undefined,
        };
    }
});
