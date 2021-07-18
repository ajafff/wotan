import test from 'ava';
import * as cp from 'child_process';
import * as path from 'path';
import { unixifyPath } from '../src/utils';
import { loadConfig } from '../src/cli';

function execCli(args: string[]): Promise<{err: Error | null, stdout: string, stderr: string, code: number}> {
    interface ErrorWithCode extends Error {
        code: number;
    }
    return new Promise((resolve) => {
        cp.exec(
            `node src/cli '${args.join("' '")}'`,
            {cwd: 'packages/wotan'},
            (err, stdout, stderr) => resolve({err, stdout, stderr, code: err ? (<ErrorWithCode>err).code : 0}),
        );
    });
}

test('exits with code 0 on success', async (t) => {
    t.is((await execCli(['show', 'src/index.ts'])).code, 0);
});

test('prints version', async (t) => {
    const version = require('../package.json').version;
    t.deepEqual(await execCli(['-v']), {stdout: `${version}\n`, stderr: '', code: 0, err: null});
    t.is((await execCli(['--version'])).stdout, `${version}\n`);
});

test('exits with code 1 on configuration error', async (t) => {
    const result = await execCli(['show', '--wrong-option']);
    t.is(result.stderr, `Unknown option '--wrong-option'.\n`);
    t.is(result.code, 1);
    t.is(result.stdout, '');
});

test('exits with code 1 on exception and prints stack trace', async (t) => {
    const result = await execCli(['lint', __filename, '-c', 'test/fixtures/configuration/invalid-rule.yaml']);
    t.is(result.code, 1);
    t.true(result.stderr.startsWith(path.resolve('packages/wotan/test/fixtures/invalid.js:')));
    t.regex(result.stderr, /SyntaxError:/);
    t.is(result.stdout, '');
});

test('exits with code 2 on lint error', async (t) => {
    const result = await execCli(['lint', '../mimir/test/trailing-newline/whitespace.ts', '-f', 'json']);
    t.is(result.stderr, '');
    t.is(result.code, 2);
    t.is(result.stdout, `[
{"ruleName":"trailing-newline","severity":"error","message":"File must end with a newline.","start":{"position":5,"line":0,"character":5},"end":{"position":5,"line":0,"character":5},"fix":{"description":"auto fix","replacements":[{"start":5,"end":5,"text":"\\n"}]},"fileName":"${unixifyPath(path.resolve('packages/mimir/test/trailing-newline/whitespace.ts'))}"}
]
`);
});

test('loads .fimbullinter.yaml file', async (t) => {
    t.deepEqual(await loadConfig(__dirname), {}, 'empty if not found');
    t.deepEqual(await loadConfig(path.join(__dirname, 'fixtures/global-config/invalid')), {}, 'empty on parse error');
    t.deepEqual(await loadConfig(path.join(__dirname, 'fixtures/global-config/empty')), {}, 'empty object on falsy value');
    t.deepEqual(
        await loadConfig(path.join(__dirname, 'fixtures/global-config')),
        {project: 'tsconfig.base.json', fix: true, exclude: ['**/*.d.ts']},
    );
});
