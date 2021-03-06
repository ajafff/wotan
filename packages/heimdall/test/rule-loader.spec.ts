import test from 'ava';
import { TslintRuleLoaderHost } from '../src';
import * as path from 'path';
import {
    NodeResolver,
    CachedFileSystem,
    NodeFileSystem,
    ConsoleMessageHandler,
    DefaultCacheFactory,
    NodeDirectoryService,
} from '@fimbul/wotan';

test('loads TSLint rule as custom rule if no wotan rule is found', (t) => {
    const loader = new TslintRuleLoaderHost(
        {
            resolveConfig() { throw new Error(); },
            resolveFormatter() { throw new Error(); },
            resolveRule(name) { return path.join(__dirname, '../../mimir/src/rules', name + '.js'); },
        },
        new NodeResolver(
            new CachedFileSystem(new NodeFileSystem(new ConsoleMessageHandler()), new DefaultCacheFactory()),
            new NodeDirectoryService(),
        ),
    );
    t.is(loader.loadCustomRule('my-rule', path.resolve('packages/heimdall/test/fixtures')), require('./fixtures/my-rule').Rule);
    t.not(loader.loadCustomRule('semicolon', '/'), undefined);
    t.not(loader.loadCustomRule('my-tslint-rule', path.resolve('packages/heimdall/test/fixtures')), undefined);
    t.is(loader.loadCustomRule('non-existent-rule-name', '/'), undefined);
});
