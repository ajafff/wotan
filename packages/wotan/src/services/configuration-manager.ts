import { injectable } from 'inversify';
import { CachedFileSystem } from './cached-file-system';
import {
    Resolver,
    Configuration,
    RawConfiguration,
    CacheManager,
    CacheIdentifier,
    Cache,
    ReducedConfiguration,
    GlobalSettings,
    DirectoryService,
} from '../types';
import * as path from 'path';
import * as json5 from 'json5';
import { ConfigurationError } from '../error';
import * as yaml from 'js-yaml';
import { OFFSET_TO_NODE_MODULES, arrayify, resolveCachedResult } from '../utils';
import { reduceConfigurationForFile, getProcessorForFile, getSettingsForFile } from '../configuration';

export const CONFIG_EXTENSIONS = ['.yaml', '.yml', '.json5', '.json', '.js'];
export const CONFIG_FILENAMES = CONFIG_EXTENSIONS.map((ext) => '.wotanrc' + ext);

// TODO refactor to use a ConfigurationReader/Finder instead of direct IO

const configCache = new CacheIdentifier<string, Configuration>('configuration');

@injectable()
export class ConfigurationManager {
    private configCache: Cache<string, Configuration>;
    constructor(
        private fs: CachedFileSystem,
        private resolver: Resolver,
        private directories: DirectoryService,
        cache: CacheManager,
    ) {
        this.configCache = cache.create(configCache);
    }

    public findConfigurationPath(file: string): string | undefined {
        let result = this.findupConfig(path.resolve(this.directories.getCurrentDirectory(), file));
        if (result === undefined && this.directories.getHomeDirectory !== undefined)
            result = this.findConfigFileInDirectory(this.directories.getHomeDirectory());
        return result;
    }

    public findConfiguration(file: string): Configuration | undefined {
        const config = this.findConfigurationPath(file);
        return config === undefined ? undefined : this.loadConfigurationFromPath(config);
    }

    public readConfigurationFile(filename: string): RawConfiguration {
        filename = path.resolve(this.directories.getCurrentDirectory(), filename);
        try {
            switch (path.extname(filename)) {
                case '.json':
                case '.json5':
                    return json5.parse(this.fs.readFile(filename));
                case '.yaml':
                case '.yml':
                    return yaml.safeLoad(this.fs.readFile(filename), {
                        schema: yaml.JSON_SCHEMA,
                        strict: true,
                    });
                default:
                    return this.resolver.require(filename, {cache: false});
            }
        } catch (e) {
            throw new ConfigurationError(`Error parsing '${filename}': ${e && e.message}`);
        }
    }

    public resolveConfigFile(name: string, basedir: string): string {
        if (name.startsWith('wotan:')) {
            const fileName = path.join(__dirname, `../configs/${name.substr('wotan:'.length)}.yaml`);
            if (!this.fs.isFile(fileName))
                throw new ConfigurationError(`'${name}' is not a valid builtin configuration, try 'wotan:recommended'.`);
            return fileName;
        }
        basedir = path.resolve(this.directories.getCurrentDirectory(), basedir);
        try {
            return this.resolver.resolve(name, basedir, CONFIG_EXTENSIONS, module.paths.slice(OFFSET_TO_NODE_MODULES + 1));
        } catch (e) {
            throw new ConfigurationError(e.message);
        }
    }

    public reduceConfigurationForFile(config: Configuration, file: string): ReducedConfiguration | undefined {
        return reduceConfigurationForFile(config, file, this.directories.getCurrentDirectory());
    }

    public getProcessorForFile(config: Configuration, file: string): string | undefined {
        return getProcessorForFile(config, file, this.directories.getCurrentDirectory());
    }

    public getSettingsForFile(config: Configuration, file: string): GlobalSettings {
        return getSettingsForFile(config, file, this.directories.getCurrentDirectory());
    }

    public loadConfigurationFromPath(file: string): Configuration {
        return this.loadConfigurationFromPathWorker(path.resolve(this.directories.getCurrentDirectory(), file), [file]);
    }

    private loadConfigurationFromPathWorker(file: string, stack: string[]): Configuration {
        return resolveCachedResult(this.configCache, file, () => {
            return this.parseConfigWorker(this.readConfigurationFile(file), file, stack);
        });
    }

    public parseConfiguration(raw: RawConfiguration, filename: string): Configuration {
        filename = path.resolve(this.directories.getCurrentDirectory(), filename);
        return this.parseConfigWorker(raw, filename, [filename]);
    }

    private parseConfigWorker(raw: RawConfiguration, filename: string, stack: string[]): Configuration {
        const dirname = path.dirname(filename);
        const base = arrayify(raw.extends).map((name) => {
            name = this.resolveConfigFile(name, dirname);
            if (stack.includes(name))
                throw new ConfigurationError(`Circular configuration dependency ${stack.join(' => ')} => ${name}`);
            return this.loadConfigurationFromPathWorker(name, [...stack, name]);
        });
        return {
            filename,
            extends: base,
            aliases: raw.aliases && mapAliases(raw.aliases),
            overrides: raw.overrides && raw.overrides.map((o) => this.mapOverride(o, dirname)),
            rules: raw.rules && mapRules(raw.rules),
            rulesDirectories: raw.rulesDirectories && this.mapRulesDirectory(raw.rulesDirectories, dirname),
            processor: this.mapProcessor(raw.processor, dirname),
            exclude: Array.isArray(raw.exclude) ? raw.exclude : raw.exclude === undefined ? undefined : [raw.exclude],
            settings: raw.settings && mapSettings(raw.settings),
        };
    }

    private mapOverride(raw: RawConfiguration.Override, basedir: string): Configuration.Override {
        const files = arrayify(raw.files);
        if (files.length === 0)
            throw new ConfigurationError(`Override does not specify files.`);
        return {
            files: arrayify(raw.files),
            rules: raw.rules && mapRules(raw.rules),
            settings: raw.settings && mapSettings(raw.settings),
            processor: this.mapProcessor(raw.processor, basedir),
        };
    }

    private mapProcessor(processor: RawConfiguration['processor'], basedir: string): Configuration['processor'] {
        return processor && this.resolver.resolve(
            processor,
            basedir,
            Object.keys(require.extensions).filter((ext) => ext !== '.json' && ext !== '.node'),
            module.paths.slice(OFFSET_TO_NODE_MODULES + 1),
        );
    }

    private mapRulesDirectory(raw: {[prefix: string]: string}, dirname: string) {
        const result = new Map<string, string>();
        for (const key of Object.keys(raw))
            result.set(key, path.resolve(dirname, raw[key]));
        return result;
    }

    private findupConfig(current: string): string | undefined {
        let next = path.dirname(current);
        while (next !== current) {
            current = next;
            const config = this.findConfigFileInDirectory(current);
            if (config !== undefined)
                return config;
            next = path.dirname(next);
        }
        return;
    }

    private findConfigFileInDirectory(dir: string): string | undefined {
        for (let name of CONFIG_FILENAMES) {
            name = path.join(dir, name);
            if (this.fs.isFile(name))
                return name;
        }
        return;
    }
}

function mapAliases(aliases: {[prefix: string]: {[name: string]: RawConfiguration.Alias | null | false }}) {
    const result: Configuration['aliases'] = new Map();
    for (const prefix of Object.keys(aliases)) {
        const obj = aliases[prefix];
        if (!obj)
            continue;
        for (const name of Object.keys(obj)) {
            const config = obj[name];
            const fullName = `${prefix}/${name}`;
            if (config && !config.rule)
                throw new ConfigurationError(`Alias '${fullName}' does not specify a rule.`);
            result.set(fullName, config);
        }
    }
    return result;
}

function mapRules(raw: {[name: string]: RawConfiguration.RuleConfigValue}) {
    const result: Configuration['rules'] = new Map();
    for (const key of Object.keys(raw))
        result.set(key, mapRuleConfig(raw[key]));
    return result;
}

function mapRuleConfig(value: RawConfiguration.RuleConfigValue): Configuration.RuleConfig {
    if (typeof value === 'string')
        return { severity: mapRuleSeverity(value) };
    if (!value)
        return {};
    const result: Configuration.RuleConfig = {};
    if ('options' in value)
        result.options = value.options;
    if ('severity' in value)
        result.severity = mapRuleSeverity(value.severity!);
    return result;
}

function mapRuleSeverity(severity: RawConfiguration.RuleSeverity): Configuration.RuleSeverity {
    switch (severity) {
        case 'off':
            return 'off';
        case 'warn':
        case 'warning':
            return 'warning';
        default:
            return 'error';
    }
}

function mapSettings(settings: {[key: string]: any}) {
    const result: Configuration['settings'] = new Map();
    for (const key of Object.keys(settings))
        result.set(key, settings[key]);
    return result;
}
