import 'reflect-metadata';
import test from 'ava';
import { Container, injectable } from 'inversify';
import { MessageHandler, FileSystem, Format, DirectoryService, CacheFactory, GlobalOptions, Stats } from '@fimbul/ymir';
import { runCommand, CommandName, ShowCommand, SaveCommand, TestCommand } from '../src/commands';
import { NodeFileSystem } from '../src/services/default/file-system';
import * as path from 'path';
import { unixifyPath, format } from '../src/utils';
import * as escapeRegex from 'escape-string-regexp';
import { DefaultCacheFactory } from '../src/services/default/cache-factory';
import { createCoreModule } from '../src/di/core.module';
import { createDefaultModule } from '../src/di/default.module';
import chalk from 'chalk';
import { ConsoleMessageHandler } from '../src/services/default/message-handler';

test.before(() => {
    chalk.enabled = false;
});

test('ShowCommand', async (t) => {
    const container = new Container();
    const logger: MessageHandler = {
        log() {},
        warn() { throw new Error('not implemented'); },
        error() { throw new Error('not implemented'); },
    };
    container.bind(CacheFactory).to(DefaultCacheFactory).inSingletonScope();
    container.bind(MessageHandler).toConstantValue(logger);
    const cwd = path.join(path.parse(process.cwd()).root, '.chroot');
    container.bind(DirectoryService).toConstantValue({
        getCurrentDirectory() { return cwd; },
    });

    @injectable()
    class MockFileSystem extends NodeFileSystem {
        constructor(messageHandler: MessageHandler) {
            super(messageHandler);
        }

        public normalizePath(file: string) {
            return super.normalizePath(path.resolve(path.relative(cwd, file)));
        }
        public stat(file: string) {
            // everything above cwd does not exist
            if (path.relative(super.normalizePath(process.cwd()), file).startsWith('..' + path.sep))
                throw new Error();
            return super.stat(file);
        }
    }
    container.bind(FileSystem).to(MockFileSystem);

    void t.throws(
        verify({
            command: CommandName.Show,
            modules: ['non-existent'],
            file: 'foo.ts',
            format: undefined,
            config: undefined,
        }),
        `Cannot find module 'non-existent' from '${process.cwd()}'`,
    );

    void t.throws(
        verify({
            command: CommandName.Show,
            modules: ['./packages/wotan/test/fixtures/node_modules/my-config'],
            file: 'foo.ts',
            format: undefined,
            config: undefined,
        }),
        `Module '${path.resolve('./packages/wotan/test/fixtures/node_modules/my-config')}.js' does not export a function 'createModule'.`,
    );

    void t.throws(
        verify({
            command: CommandName.Show,
            modules: [],
            file: '../foo.ts',
            format: undefined,
            config: undefined,
        }),
        "Cannot find configuration for '../foo.ts'.",
    );

    void t.throws(
        verify({
            command: CommandName.Show,
            modules: [],
            file: '../foo.ts',
            format: undefined,
            config: 'non-existent.conf',
        }),
        `Cannot find module 'non-existent.conf' from '${cwd}'`,
    );

    await verify({
        command: CommandName.Show,
        modules: [],
        file: 'packages/wotan/test/fixtures/configuration/foo.ts',
        format: undefined,
        config: undefined,
    });

    await verify({
        command: CommandName.Show,
        modules: [],
        file: 'packages/wotan/test/fixtures/configuration/foo.js',
        format: undefined,
        config: undefined,
    });

    await verify({
        command: CommandName.Show,
        modules: [],
        file: 'packages/wotan/test/fixtures/configuration/foo.ts',
        format: Format.Json,
        config: undefined,
    });

    await verify({
        command: CommandName.Show,
        modules: [],
        file: 'packages/wotan/test/fixtures/configuration/foo.ts',
        format: Format.Json5,
        config: undefined,
    });

    await verify({
        command: CommandName.Show,
        modules: [],
        file: 'packages/wotan/test/fixtures/configuration/other-config.ts',
        format: undefined,
        config: 'packages/wotan/test/fixtures/configuration/base.yaml',
    });

    async function verify(command: ShowCommand) {
        let called = false;
        logger.log = (output) => {
            t.snapshot(normalizePaths(output), {id: `${t.title} ${command.file} ${command.format}`});
            called = true;
        };
        t.true(await runCommand(command, container));
        t.true(called);
    }
    function normalizePaths(str: string): string {
        // replace `cwd` with / and all backslashes with forward slash
        const re = new RegExp(`(- )?(['"]?)${escapeRegex(cwd)}(.*?)\\2(,?)$`, 'gm');
        return str.replace(/\\\\/g, '\\').replace(re, (_, dash, quote, p, comma) => dash && !comma
            ? dash + unixifyPath(p)
            : quote + unixifyPath(p) + quote + comma);
    }
});

test('SaveCommand', async (t) => {
    t.deepEqual(
        await verify({
            command: CommandName.Save,
            project: undefined,
            config: undefined,
            fix: false,
            exclude: [],
            files: [],
            extensions: undefined,
            formatter: undefined,
            modules: [],
        }),
        {
            content: false,
            log: "Removed '.fimbullinter.yaml'.",
        },
        'removes file if empty',
    );
    t.deepEqual(
        await verify(
            {
                command: CommandName.Save,
                project: undefined,
                config: undefined,
                fix: 0,
                exclude: [],
                files: [],
                extensions: undefined,
                formatter: undefined,
                modules: [],
            },
            {
                project: 'foo',
            },
            true,
        ),
        {
            content: false,
            log: undefined,
        },
        "doesn't crash if file does not exist",
    );
    t.deepEqual(
        await verify(
            {
                command: CommandName.Save,
                project: undefined,
                config: '.wotanrc.yaml',
                fix: true,
                exclude: [],
                files: ['**/*.d.ts'],
                extensions: undefined,
                formatter: undefined,
                modules: [],
            },
            {
                project: 'foo.json',
                modules: ['foo', 'bar'],
            },
        ),
        {
            content: format({config: '.wotanrc.yaml', fix: true, files: ['**/*.d.ts']}, Format.Yaml),
            log: "Updated '.fimbullinter.yaml'.",
        },
        'overrides existing options',
    );
    t.deepEqual(
        await verify(
            {
                command: CommandName.Save,
                project: undefined,
                config: undefined,
                fix: 0,
                exclude: [],
                files: [],
                extensions: undefined,
                formatter: undefined,
                modules: [],
            },
            {
                other: 'foo',
                project: 'bar',
            },
        ),
        {
            content: format({other: 'foo'}, Format.Yaml),
            log: "Updated '.fimbullinter.yaml'.",
        },
        'preserves other config values',
    );

    async function verify(command: SaveCommand, defaults?: GlobalOptions, throwOnDelete?: boolean) {
        const container = new Container();
        let content: string | false | undefined;
        const fileSystem: FileSystem = {
            normalizePath(p) { return p; },
            readFile() { throw new Error(); },
            readDirectory() { throw new Error(); },
            stat() { throw new Error(); },
            createDirectory() { throw new Error(); },
            writeFile(f, c) {
                t.is(f, path.resolve('.fimbullinter.yaml'));
                content = c;
            },
            deleteFile(f) {
                t.is(f, path.resolve('.fimbullinter.yaml'));
                content = false;
                if (throwOnDelete)
                    throw new Error('ENOENT');
            },
        };
        container.bind(FileSystem).toConstantValue(fileSystem);
        let log: string | undefined;
        const logger: MessageHandler = {
            log(m) { log = m; },
            warn() { throw new Error(); },
            error() { throw new Error(); },
        };
        container.bind(MessageHandler).toConstantValue(logger);
        container.load(createCoreModule({}), createDefaultModule());

        await runCommand(command, container, defaults);
        return {
            log,
            content,
        };
    }
});

test('ValidateCommand', async (t) => {
    t.is(
        await runCommand({
            command: CommandName.Validate,
            modules: [],
            files: [],
        }),
        true,
    );
});

test('LintCommand', async (t) => {
    const container = new Container();

    let filesWritten: Record<string, string> = {};
    @injectable()
    class MockFileSystem extends NodeFileSystem {
        constructor(logger: MessageHandler) {
            super(logger);
        }
        public writeFile(f: string, content: string) {
            filesWritten[f] = content;
        }
    }
    container.bind(FileSystem).to(MockFileSystem);

    let output: string[] = [];
    container.bind(MessageHandler).toConstantValue({
        log(m) { output.push(m); },
        warn() { throw new Error(); },
        error() { throw new Error(); },
    });

    const cwd = path.join(__dirname, 'fixtures/test').toLowerCase();
    container.bind(DirectoryService).toConstantValue({
        getCurrentDirectory() { return cwd; },
    });

    t.is(
        await runCommand(
            {
                command: CommandName.Lint,
                modules: [],
                files: ['*.ts'],
                exclude: [],
                config: '.wotanrc.yaml',
                project: undefined,
                formatter: undefined,
                fix: true,
                extensions: undefined,
            },
            container,
        ),
        true,
    );
    t.deepEqual(filesWritten, {});
    t.is(output.join('\n'), '');

    t.is(
        await runCommand(
            {
                command: CommandName.Lint,
                modules: [],
                files: ['*.ts'],
                exclude: [],
                config: '.wotanrc.fail.yaml',
                project: undefined,
                formatter: undefined,
                fix: true,
                extensions: undefined,
            },
            container,
        ),
        false,
    );
    t.deepEqual(filesWritten, {});
    t.is(output.join('\n'), `
${path.join(cwd, '2.ts')}:2:1
ERROR 2:1  no-unused-expression  This expression is unused. Did you mean to assign a value or call a function?

${path.join(cwd, '3.ts')}:2:8
ERROR 2:8  no-unused-expression  This expression is unused. Did you mean to assign a value or call a function?

✖ 2 errors
`.trim());

    output = [];

    t.is(
        await runCommand(
            {
                command: CommandName.Lint,
                modules: [],
                files: ['*.ts'],
                exclude: [],
                config: '.wotanrc.fail-fix.yaml',
                project: undefined,
                formatter: undefined,
                fix: true,
                extensions: undefined,
            },
            container,
        ),
        true,
    );
    t.deepEqual(filesWritten, {
        [unixifyPath(path.join(cwd, '3.ts'))]: `"bar";\n'baz';\n`,
    });
    t.is(output.join('\n'), 'Automatically fixed 1 failure.');

    output = [];
    filesWritten = {};
    t.is(
        await runCommand(
            {
                command: CommandName.Lint,
                modules: [],
                files: ['*.ts'],
                exclude: [],
                config: '.wotanrc.fail-fix.yaml',
                project: undefined,
                formatter: undefined,
                fix: false,
                extensions: undefined,
            },
            container,
        ),
        false,
    );
    t.deepEqual(filesWritten, {});
    t.is(output.join('\n'), `
${path.join(cwd, '3.ts')}:2:1
ERROR 2:1  no-unused-label  Unused label 'label'.

✖ 1 error
1 failure is potentially fixable with the '--fix' option.
`.trim());

});

test('TestCommand', async (t) => {
    let cwd = path.join(__dirname, 'fixtures').toLowerCase();
    const directories: DirectoryService = {
        getCurrentDirectory() { return cwd; },
    };

    void t.throws(
        verify({
            command: CommandName.Test,
            bail: false,
            exact: false,
            files: ['test/subdir/.*.test.json'],
            updateBaselines: false,
            modules: [],
        }),
        `Testing file '${unixifyPath(path.join(cwd, 'test/1.ts'))}' outside of '${unixifyPath(path.join(cwd, 'test/subdir'))}'.`,
    );

    t.deepEqual(
        await verify({
            command: CommandName.Test,
            bail: false,
            exact: false,
            files: ['test/.*.test.json'],
            updateBaselines: false,
            modules: [],
        }),
        {
            output: `
${path.normalize('test/.fail-fix.test.json')}
  ${path.normalize('baselines/.fail-fix/1.ts.lint MISSING')}
  ${path.normalize('baselines/.fail-fix/2.ts.lint MISSING')}
  ${path.normalize('baselines/.fail-fix/3.ts.lint MISSING')}
  ${path.normalize('baselines/.fail-fix/3.ts.fix MISSING')}
${path.normalize('test/.fail.test.json')}
  ${path.normalize('baselines/.fail/1.ts.lint MISSING')}
  ${path.normalize('baselines/.fail/2.ts.lint MISSING')}
  ${path.normalize('baselines/.fail/3.ts.lint MISSING')}
${path.normalize('test/.success.test.json')}
  ${path.normalize('baselines/.success/1.ts.lint MISSING')}
  ${path.normalize('baselines/.success/2.ts.lint MISSING')}
  ${path.normalize('baselines/.success/3.ts.lint MISSING')}
`.trim(),
            success: false,
        },
    );

    t.deepEqual(
        await verify({
            command: CommandName.Test,
            bail: true,
            exact: false,
            files: ['test/.*.test.json'],
            updateBaselines: false,
            modules: [],
        }),
        {
            output: `
${path.normalize('test/.fail-fix.test.json')}
  ${path.normalize('baselines/.fail-fix/1.ts.lint MISSING')}
`.trim(),
            success: false,
        },
    );

    {
            const container = new Container();
            @injectable()
            class MockFileSystem extends NodeFileSystem {
                constructor(logger: MessageHandler) {
                    super(logger);
                }

                public normalizePath(f: string) {
                    return super.normalizePath(f).replace(/\/baselines\/.success\/(\d)\.ts\.(lint|fix)$/, '/test/$1.ts');
                }
            }
            container.bind(FileSystem).to(MockFileSystem);
            container.bind(MessageHandler).to(ConsoleMessageHandler);

            t.deepEqual(
                await verify(
                    {
                        command: CommandName.Test,
                        bail: true,
                        exact: false,
                        files: ['test/.success.test.json'],
                        updateBaselines: false,
                        modules: [],
                    },
                    container,
                ),
                {
                    output: `
${path.normalize('test/.success.test.json')}
  ${path.normalize('baselines/.success/1.ts.lint PASSED')}
  ${path.normalize('baselines/.success/2.ts.lint PASSED')}
  ${path.normalize('baselines/.success/3.ts.lint PASSED')}
  ${path.normalize('baselines/.success/1.ts.fix EXISTS')}
`.trim(),
                    success: false,
                },
            );
    }

    {
        const deleted: string[] = [];
        const written: Record<string, string> = {};
        const container = new Container();
        @injectable()
        class MockFileSystem extends NodeFileSystem {
            constructor(logger: MessageHandler) {
                super(logger);
            }

            public stat(f: string): Stats {
                if (f.includes('/baselines/'))
                    return {
                        isFile() { return true; },
                        isDirectory() { return false; },
                    };
                return super.stat(f);
            }

            public readFile(f: string): string {
                if (f.includes('/baselines/'))
                    return '\uFEFF\t\r\n~ [error foo: bar\tbaz]\n';
                return super.readFile(f);
            }

            public deleteFile(f: string) {
                deleted.push(f);
            }

            public writeFile(f: string, content: string) {
                written[f] = content;
            }
        }
        container.bind(FileSystem).to(MockFileSystem);
        container.bind(MessageHandler).to(ConsoleMessageHandler);

        t.deepEqual(
            await verify(
                {
                    command: CommandName.Test,
                    bail: false,
                    exact: false,
                    files: ['test/.fail-fix.test.json'],
                    updateBaselines: false,
                    modules: [],
                },
                container),
            {
                output: `
${path.normalize('test/.fail-fix.test.json')}
  ${path.normalize('baselines/.fail-fix/1.ts.lint FAILED')}
Expected
Actual
@@ -1,2 +1,1 @@
-<BOM>␉␍
-~ [error foo: bar␉baz]
+export {};

  ${path.normalize('baselines/.fail-fix/2.ts.lint FAILED')}
Expected
Actual
@@ -1,2 +1,2 @@
-<BOM>␉␍
-~ [error foo: bar␉baz]
+export {};
+'foo';

  ${path.normalize('baselines/.fail-fix/3.ts.lint FAILED')}
Expected
Actual
@@ -1,2 +1,3 @@
-<BOM>␉␍
-~ [error foo: bar␉baz]
+"bar";
+label: 'baz';
+~~~~~         [error no-unused-label: Unused label 'label'.]

  ${path.normalize('baselines/.fail-fix/1.ts.fix EXISTS')}
  ${path.normalize('baselines/.fail-fix/2.ts.fix EXISTS')}
  ${path.normalize('baselines/.fail-fix/3.ts.fix FAILED')}
Expected
Actual
@@ -1,2 +1,2 @@
-<BOM>␉␍
-~ [error foo: bar␉baz]
+"bar";
+'baz';
`.trimLeft(),
                success: false,
            },
        );
        t.is(deleted.length, 0);
        t.deepEqual(written, {});

        t.deepEqual(
            await verify(
                {
                    command: CommandName.Test,
                    bail: false,
                    exact: false,
                    files: ['test/.fail-fix.test.json'],
                    updateBaselines: true,
                    modules: [],
                },
                container),
            {
                output: `
${path.normalize('test/.fail-fix.test.json')}
  ${path.normalize('baselines/.fail-fix/1.ts.lint UPDATED')}
  ${path.normalize('baselines/.fail-fix/2.ts.lint UPDATED')}
  ${path.normalize('baselines/.fail-fix/3.ts.lint UPDATED')}
  ${path.normalize('baselines/.fail-fix/1.ts.fix REMOVED')}
  ${path.normalize('baselines/.fail-fix/2.ts.fix REMOVED')}
  ${path.normalize('baselines/.fail-fix/3.ts.fix UPDATED')}
`.trim(),
                success: true,
            },
        );
        t.deepEqual(deleted, [
            unixifyPath(path.resolve(cwd, 'baselines/.fail-fix/1.ts.fix')),
            unixifyPath(path.resolve(cwd, 'baselines/.fail-fix/2.ts.fix')),
        ]);
        t.deepEqual(written, {
            [unixifyPath(path.resolve(cwd, 'baselines/.fail-fix/1.ts.lint'))]: 'export {};\n',
            [unixifyPath(path.resolve(cwd, 'baselines/.fail-fix/2.ts.lint'))]: "export {};\n'foo';\n",
            [unixifyPath(path.resolve(cwd, 'baselines/.fail-fix/3.ts.lint'))]:
                `"bar";\nlabel: 'baz';\n~~~~~         [error no-unused-label: Unused label 'label'.]\n`,
            [unixifyPath(path.resolve(cwd, 'baselines/.fail-fix/3.ts.fix'))]: `"bar";\n'baz';\n`,
        });
    }

    {
        const directoriesCreated: string[] = [];
        const written: Record<string, string> = {};
        const container = new Container();
        @injectable()
        class MockFileSystem extends NodeFileSystem {
            constructor(logger: MessageHandler) {
                super(logger);
            }

            public readFile(f: string) {
                if (f.endsWith('/baselines/.success/1.ts.lint'))
                    return '';
                return super.readFile(f);
            }

            public writeFile(f: string, content: string) {
                written[f] = content;
            }

            public createDirectory(d: string) {
                directoriesCreated.push(d);
                if (directoriesCreated.length === 1)
                    throw new Error();
            }
        }
        container.bind(FileSystem).to(MockFileSystem);
        container.bind(MessageHandler).to(ConsoleMessageHandler);

        t.deepEqual(
            await verify(
                {
                    command: CommandName.Test,
                    bail: false,
                    exact: false,
                    files: ['test/.success.test.json'],
                    updateBaselines: true,
                    modules: [],
                },
                container),
            {
                output: `
${path.normalize('test/.success.test.json')}
  ${path.normalize('baselines/.success/1.ts.lint UPDATED')}
  ${path.normalize('baselines/.success/2.ts.lint CREATED')}
  ${path.normalize('baselines/.success/3.ts.lint CREATED')}
`.trim(),
                success: true,
            },
        );

        t.deepEqual(written, {
            [unixifyPath(path.resolve(cwd, 'baselines/.success/1.ts.lint'))]: 'export {};\n',
            [unixifyPath(path.resolve(cwd, 'baselines/.success/2.ts.lint'))]: "export {};\n'foo';\n",
            [unixifyPath(path.resolve(cwd, 'baselines/.success/3.ts.lint'))]: `"bar";\nlabel: 'baz';\n`,
        });
        t.deepEqual(directoriesCreated, [
            unixifyPath(path.join(cwd, 'baselines/.success')),
            unixifyPath(path.join(cwd, 'baselines')),
            unixifyPath(path.join(cwd, 'baselines/.success')),
        ]);
    }

    // CWD changes here!
    cwd = path.join(cwd, 'test');

    t.deepEqual(
        await verify({
            command: CommandName.Test,
            bail: false,
            exact: true,
            files: ['.fail-fix.test.json'],
            updateBaselines: false,
            modules: [],
        }),
        {
            output: `
${path.normalize('.fail-fix.test.json')}
  ${path.normalize('baselines/.fail-fix/1.ts.lint PASSED')}
  ${path.normalize('baselines/.fail-fix/2.ts.lint PASSED')}
  ${path.normalize('baselines/.fail-fix/3.ts.lint PASSED')}
  ${path.normalize('baselines/.fail-fix/3.ts.fix PASSED')}
  ${path.normalize('baselines/.fail-fix/4.ts.fix UNCHECKED')}
  ${path.normalize('baselines/.fail-fix/4.ts.lint UNCHECKED')}
`.trim(),
            success: false,
        },
    );

    t.deepEqual(
        await verify({
            command: CommandName.Test,
            bail: true,
            exact: true,
            files: ['.fail-fix.test.json'],
            updateBaselines: false,
            modules: [],
        }),
        {
            output: `
${path.normalize('.fail-fix.test.json')}
  ${path.normalize('baselines/.fail-fix/1.ts.lint PASSED')}
  ${path.normalize('baselines/.fail-fix/2.ts.lint PASSED')}
  ${path.normalize('baselines/.fail-fix/3.ts.lint PASSED')}
  ${path.normalize('baselines/.fail-fix/3.ts.fix PASSED')}
  ${path.normalize('baselines/.fail-fix/4.ts.fix UNCHECKED')}
`.trim(),
            success: false,
        },
    );

    {
        const deleted: string[] = [];
        const container = new Container();
        @injectable()
        class MockFileSystem extends NodeFileSystem {
            constructor(logger: MessageHandler) {
                super(logger);
            }

            public deleteFile(f: string) {
                deleted.push(f);
            }
        }
        container.bind(FileSystem).to(MockFileSystem);
        container.bind(MessageHandler).to(ConsoleMessageHandler);

        t.deepEqual(
            await verify(
                {
                    command: CommandName.Test,
                    bail: false,
                    exact: true,
                    files: ['.fail-fix.test.json'],
                    updateBaselines: true,
                    modules: [],
                },
                container,
            ),
            {
                output: `
${path.normalize('.fail-fix.test.json')}
  ${path.normalize('baselines/.fail-fix/1.ts.lint PASSED')}
  ${path.normalize('baselines/.fail-fix/2.ts.lint PASSED')}
  ${path.normalize('baselines/.fail-fix/3.ts.lint PASSED')}
  ${path.normalize('baselines/.fail-fix/3.ts.fix PASSED')}
  ${path.normalize('baselines/.fail-fix/4.ts.fix REMOVED')}
  ${path.normalize('baselines/.fail-fix/4.ts.lint REMOVED')}
`.trim(),
                success: true,
            },
        );

        t.deepEqual(deleted, [
            unixifyPath(path.resolve(cwd, 'baselines/.fail-fix/4.ts.fix')),
            unixifyPath(path.resolve(cwd, 'baselines/.fail-fix/4.ts.lint')),
        ]);
    }

    async function verify(command: TestCommand, parentContainer?: Container) {
        const container = new Container();
        if (parentContainer)
            container.parent = parentContainer;
        container.bind(DirectoryService).toConstantValue(directories);
        const output: string[] = [];
        container.bind(MessageHandler).toConstantValue({
            log(message) { output.push(message); },
            warn() { throw new Error(); },
            error() { throw new Error(); },
        });
        const success = await runCommand(command, container);
        return {
            success,
            output: output.join('\n'),
        };
    }
});
