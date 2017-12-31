import test from 'ava';
import { reduceConfigurationForFile } from '../../src/configuration';
import { Configuration, EffectiveConfiguration } from '../../src/types';

test.skip('findConfigurationPath returns closest .wotanrc', (_t) => {
    /*t.is(
        findConfigurationPath('test/fixtures/configuration/config-findup/foo.ts'),
        path.resolve('test/fixtures/configuration/config-findup/.wotanrc.yaml'),
    );
    t.is(
        findConfigurationPath('test/fixtures/configuration/config-findup/a/foo.ts'),
        path.resolve('test/fixtures/configuration/config-findup/a/.wotanrc.json'),
    );
    t.is(
        findConfigurationPath('test/fixtures/configuration/config-findup/a/aa/foo.ts'),
        path.resolve('test/fixtures/configuration/config-findup/a/.wotanrc.json'),
    );
    t.is(
        findConfigurationPath('test/fixtures/configuration/config-findup/b/foo.ts'),
        path.resolve('test/fixtures/configuration/config-findup/.wotanrc.yaml'),
    );*/
});

test('Circular aliases throw an exception', (t) => {
    const config: Configuration = {
        aliases: {
            'my/ok': { rule: 'no-debugger' },
            'my/foo': { rule: 'my/foo' },
            'my/bar': { rule: 'other/bar' },
            'other/bar': { rule: 'my/bar' },
        },
        extends: [],
        filename: '/config.yaml',
        overrides: [
            {
                files: ['a.ts'],
                rules: { 'my/ok': { severity: 'error' } },
            },
            {
                files: ['b.ts'],
                rules: { 'my/foo': { severity: 'error' } },
            },
            {
                files: ['c.ts'],
                rules: { 'my/bar': { severity: 'error' } },
            },
            {
                files: ['d.ts'],
                rules: { 'other/bar': { severity: 'error' } },
            },
        ],
    };
    t.deepEqual<EffectiveConfiguration | undefined>(reduceConfigurationForFile(config, '/a.ts', '/'), {
        processor: undefined,
        settings: new Map(),
        rules: new Map<string, EffectiveConfiguration.RuleConfig>([['my/ok', {
            options: undefined,
            rule: 'no-debugger',
            rulesDirectories: undefined,
            severity: 'error',
        }]]),
    });
    t.throws(() => reduceConfigurationForFile(config, '/b.ts', '/'), 'Circular alias: my/foo => my/foo.');
    t.throws(() => reduceConfigurationForFile(config, '/c.ts', '/'), 'Circular alias: my/bar => other/bar => my/bar.');
    t.throws(() => reduceConfigurationForFile(config, '/d.ts', '/'), 'Circular alias: other/bar => my/bar => other/bar.');
});

test('Aliases refer to rules or aliases in the scope they are declared', (t) => {
    const config: Configuration = {
        aliases: {
            'my/foo': { rule: 'other/foo' },
            'my/circular': { rule: 'circular/circular' },
        },
        extends: [{
            aliases: {
                'other/foo': {
                    rule: 'my/foo',
                },
                'circular/circular': {
                    rule: 'circular/circular',
                },
            },
            extends: [],
            filename: '/base.yaml',
            rulesDirectories: new Map([['my', '/baseRules']]),
        }],
        filename: '/config.yaml',
        rules: {
            'my/foo': {
                severity: 'error',
            },
        },
        overrides: [{
            files: ['b.ts'],
            rules: {
                'my/circular': {
                    severity: 'error',
                },
            },
        }],
        rulesDirectories: new Map([['my', '/extendingRules']]),
    };
    t.deepEqual<EffectiveConfiguration | undefined>(reduceConfigurationForFile(config, '/a.ts', '/'), {
        processor: undefined,
        settings: new Map(),
        rules: new Map<string, EffectiveConfiguration.RuleConfig>([['my/foo', {
            options: undefined,
            rule: 'my/foo',
            severity: 'error',
            rulesDirectories: ['/baseRules'],
        }]]),
    });

    t.throws(
        () => reduceConfigurationForFile(config, '/b.ts', '/'),
        'Circular alias: my/circular => circular/circular => circular/circular.',
    );
});

test("Aliases don't alter options unless explicitly specified", (t) => {
    const base: Configuration = {
        aliases: {
            'base/ban-with-statement': { rule: 'no-restricted-syntax', options: 'WithStatement' },
            'base/ban-delete-expression': { rule: 'no-restricted-syntax', options: 'DeleteExpression' },
        },
        extends: [],
        filename: '/base.yaml',
        rules: {
            'base/ban-with-statement': {
                severity: 'error',
            },
            'base/ban-delete-expression': {
                severity: 'error',
            },
        },
    };
    const extending1: Configuration = {
        aliases: {
            'my/ban-with-statement': { rule: 'base/ban-with-statement', options: 'SourceFile>WithStatement'},
            'my/ban-delete-expression': { rule: 'base/ban-with-statement', options: undefined },
            'my/foo': { rule: 'my/ban-with-statement' },
            'my/bar': { rule: 'my/foo' },
        },
        extends: [base],
        rules: {
            'my/ban-with-statement': {
                severity: 'error',
            },
            'my/ban-delete-expression': {
                severity: 'error',
            },
            'my/foo': {
                severity: 'error',
            },
            'my/bar': {
                severity: 'error',
                options: 'FooBar',
            },
        },
        filename: '/extending1.yaml',
    };

    t.deepEqual<EffectiveConfiguration | undefined>(reduceConfigurationForFile(extending1, '/a', '/'), {
        processor: undefined,
        settings: new Map(),
        rules: new Map<string, EffectiveConfiguration.RuleConfig>([
            [
                'base/ban-with-statement',
                { rule: 'no-restricted-syntax', options: 'WithStatement', severity: 'error', rulesDirectories: undefined},
            ],
            [
                'base/ban-delete-expression',
                { rule: 'no-restricted-syntax', options: 'DeleteExpression', severity: 'error', rulesDirectories: undefined},
            ],
            [
                'my/ban-with-statement',
                { rule: 'no-restricted-syntax', options: 'SourceFile>WithStatement', severity: 'error', rulesDirectories: undefined},
            ],
            [
                'my/ban-delete-expression',
                { rule: 'no-restricted-syntax', options: undefined, severity: 'error', rulesDirectories: undefined},
            ],
            [
                'my/foo',
                { rule: 'no-restricted-syntax', options: 'SourceFile>WithStatement', severity: 'error', rulesDirectories: undefined},
            ],
            [
                'my/bar',
                { rule: 'no-restricted-syntax', options: 'FooBar', severity: 'error', rulesDirectories: undefined},
            ],
        ]),
    });
});

test('Aliases shadow rules until cleared', (t) => {
    const base: Configuration = {
        aliases: {
            'a/ban-with-statement': { rule: 'b/no-restricted-syntax', options: 'WithStatement' },
            'b/ban-delete-expression': { rule: 'b/no-restricted-syntax', options: 'DeleteExpression' },
        },
        rulesDirectories: new Map([['b', '/baseB']]),
        extends: [],
        filename: '/base.yaml',
        rules: {
            'a/ban-with-statement': {
                severity: 'error',
            },
            'b/ban-delete-expression': {
                severity: 'error',
            },
            'b/no-restricted-syntax': {
                severity: 'error',
                options: 'AnyKeyword',
            },
        },
    };
    t.deepEqual<EffectiveConfiguration | undefined>(reduceConfigurationForFile(base, '/a.ts', '/'), {
        processor: undefined,
        settings: new Map(),
        rules: new Map<string, EffectiveConfiguration.RuleConfig>([
            [
                'a/ban-with-statement',
                { rule: 'b/no-restricted-syntax', options: 'WithStatement', severity: 'error', rulesDirectories: ['/baseB']},
            ],
            [
                'b/ban-delete-expression',
                { rule: 'b/no-restricted-syntax', options: 'DeleteExpression', severity: 'error', rulesDirectories: ['/baseB']},
            ],
            [
                'b/no-restricted-syntax',
                { rule: 'b/no-restricted-syntax', options: 'AnyKeyword', severity: 'error', rulesDirectories: ['/baseB']},
            ],
        ]),
    });

    const extending: Configuration = {
        extends: [base],
        aliases: {
            'a/ban-with-statement': null, // tslint:disable-line:no-null-keyword
            'b/ban-delete-expression': null, // tslint:disable-line:no-null-keyword
        },
        filename: '/extending.yaml',
        rulesDirectories: new Map([['b', '/extB'], ['a', '/extA']]),
        overrides: [{
            files: ['b.ts'],
            rules: {
                'a/ban-with-statement': {},
                'b/ban-delete-expression': {},
                'b/no-restricted-syntax': {},
            },
        }],
    };
    t.deepEqual<EffectiveConfiguration | undefined>(reduceConfigurationForFile(extending, '/a.ts', '/'), {
        processor: undefined,
        settings: new Map(),
        rules: new Map<string, EffectiveConfiguration.RuleConfig>([
            [
                'a/ban-with-statement',
                { rule: 'b/no-restricted-syntax', options: 'WithStatement', severity: 'error', rulesDirectories: ['/baseB']},
            ],
            [
                'b/ban-delete-expression',
                { rule: 'b/no-restricted-syntax', options: 'DeleteExpression', severity: 'error', rulesDirectories: ['/baseB']},
            ],
            [
                'b/no-restricted-syntax',
                { rule: 'b/no-restricted-syntax', options: 'AnyKeyword', severity: 'error', rulesDirectories: ['/baseB']},
            ],
        ]),
    }, 'Only clearing alias does not invalidate the reference'); // tslint:disable-line:align
    t.deepEqual<EffectiveConfiguration | undefined>(reduceConfigurationForFile(extending, '/b.ts', '/'), {
        processor: undefined,
        settings: new Map(),
        rules: new Map<string, EffectiveConfiguration.RuleConfig>([
            [
                'a/ban-with-statement',
                { rule: 'a/ban-with-statement', options: 'WithStatement', severity: 'error', rulesDirectories: ['/extA']},
            ],
            [
                'b/ban-delete-expression',
                { rule: 'b/ban-delete-expression', options: 'DeleteExpression', severity: 'error', rulesDirectories: ['/extB', '/baseB']},
            ],
            [
                'b/no-restricted-syntax',
                { rule: 'b/no-restricted-syntax', options: 'AnyKeyword', severity: 'error', rulesDirectories: ['/extB', '/baseB']},
            ],
        ]),
    }, 'Rules need to be referenced again for cleared alias to have an effect'); // tslint:disable-line:align

    const extending2: Configuration = {
        extends: [base],
        aliases: {
            'c/ban-delete-expression': { rule: 'b/ban-delete-expression' },
        },
        filename: '/extending2.yaml',
        rulesDirectories: new Map([['b', '/extB'], ['c', '/extC']]),
        rules: {
            'c/ban-delete-expression': {},
        },
    };
    t.deepEqual<EffectiveConfiguration | undefined>(reduceConfigurationForFile(extending2, '/a.ts', '/'), {
        processor: undefined,
        settings: new Map(),
        rules: new Map<string, EffectiveConfiguration.RuleConfig>([
            [
                'a/ban-with-statement',
                { rule: 'b/no-restricted-syntax', options: 'WithStatement', severity: 'error', rulesDirectories: ['/baseB']},
            ],
            [
                'b/ban-delete-expression',
                { rule: 'b/no-restricted-syntax', options: 'DeleteExpression', severity: 'error', rulesDirectories: ['/baseB']},
            ],
            [
                'b/no-restricted-syntax',
                { rule: 'b/no-restricted-syntax', options: 'AnyKeyword', severity: 'error', rulesDirectories: ['/baseB']},
            ],
            [
                'c/ban-delete-expression',
                { rule: 'b/no-restricted-syntax', options: 'DeleteExpression', severity: 'error', rulesDirectories: ['/baseB']},
            ],
        ]),
    }, 'c/ should not pick up additional rulesDirectories'); // tslint:disable-line:align
});
