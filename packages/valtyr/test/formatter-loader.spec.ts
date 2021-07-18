import test from 'ava';
import { TslintFormatterLoaderHost } from '../src/formatter-loader';

test('loads TSLint formatter', (t) => {
    const loader = new TslintFormatterLoaderHost();
    const formatter = loader.loadCoreFormatter('fileslist');
    t.truthy(formatter);
    const instance = new formatter!();
    instance.format('foo.ts', {content: '', fixes: 0, findings: [{
        ruleName: 'irrelevant',
        severity: 'error',
        message: "doesn't matter",
        start: {
            position: 0,
            line: 0,
            character: 0,
        },
        end: {
            position: 0,
            line: 0,
            character: 0,
        },
        fix: undefined,
        codeActions: undefined,
    }]});
    t.is(instance.flush!(), 'foo.ts');

    t.not(loader.loadCustomFormatter('fileslist'), undefined);
});

test('returns undefined if no formatter is found', (t) => {
    const loader = new TslintFormatterLoaderHost();
    t.is(loader.loadCoreFormatter('non-existent-formatter-name'), undefined);
    t.is(loader.loadCustomFormatter('./some-formatter'), undefined);
});
