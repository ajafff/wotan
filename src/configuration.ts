﻿import * as path from 'path';
import { Minimatch } from 'minimatch';
import { ConfigurationError } from './error';
import { Configuration, EffectiveConfiguration, GlobalSettings, ReducedConfiguration } from './types';
import * as isNegated from 'is-negated-glob';

// @internal
export function reduceConfigurationForFile(config: Configuration, filename: string, cwd: string): ReducedConfiguration | undefined {
    const rules: EffectiveConfiguration['rules'] = new Map();
    const settings: EffectiveConfiguration['settings'] = new Map();
    const result = reduceConfig(config, path.resolve(cwd, filename), {rules, settings});
    return result && {rules, settings, processor: result.processor || undefined};
}

type RulesDirectoryMap = Map<string, string[]>;
interface ResolvedAlias extends Configuration.Alias {
    rulesDirectories: string[] | undefined;
}
interface ReducedAlias extends ResolvedAlias {
    aliases: AliasMap;
}
type AliasMap = Map<string, ReducedAlias | null>;

interface ReduceResult {
    aliases: AliasMap | undefined;
    processor: string | undefined | null | false;
    rulesDirectories: RulesDirectoryMap | undefined;
}

interface Receiver {
    settings: Map<string, any>;
    rules: Map<string, EffectiveConfiguration.RuleConfig>;
}

function reduceConfig(config: Configuration, filename: string, receiver: Receiver): ReduceResult | undefined {
    const relativeFilename = path.relative(path.dirname(config.filename), filename);
    if (config.exclude && matchesGlobs(relativeFilename, config.exclude))
        return;
    let rulesDirectories: ReduceResult['rulesDirectories'];
    let copyRulesDirectories = true;
    let aliases: ReduceResult['aliases'];
    let copyAliases = true;
    let processor: ReduceResult['processor'];
    for (const base of config.extends) {
        const tmp = reduceConfig(base, filename, receiver);
        if (tmp === undefined)
            return;
        if (tmp.rulesDirectories !== undefined) {
            if (rulesDirectories === undefined) {
                rulesDirectories = tmp.rulesDirectories;
            } else {
                rulesDirectories = extendRulesDirectories(rulesDirectories, tmp.rulesDirectories, identityFn, copyRulesDirectories);
                copyRulesDirectories = false;
            }
        }
        if (tmp.aliases !== undefined) {
            if (aliases === undefined) {
                aliases = tmp.aliases;
            } else {
                if (copyAliases) {
                    copyAliases = false;
                    aliases = new Map(aliases);
                }
                for (const [name, alias] of tmp.aliases)
                    aliases.set(name, alias);
            }
        }
        if (tmp.processor !== undefined)
            processor = tmp.processor;
    }

    if (config.rulesDirectories)
        rulesDirectories = extendRulesDirectories(
            rulesDirectories === undefined ? new Map() : rulesDirectories,
            config.rulesDirectories,
            arrayFn,
            copyRulesDirectories,
        );

    if (config.aliases) {
        aliases = aliases === undefined ? new Map() : new Map(aliases);
        for (const name of Object.keys(config.aliases)) {
            const options = config.aliases[name];
            aliases.set(name, options && {
                ...options,
                aliases,
                rulesDirectories: rulesDirectories && getRulesDirectoriesByName(options.rule, rulesDirectories),
            });
        }
    }

    const result: ReduceResult = {
        rulesDirectories,
        aliases,
        processor,
    };
    extendConfig(receiver, config, result);

    if (config.overrides)
        for (const override of config.overrides)
            if (matchesGlobs(relativeFilename, override.files))
                extendConfig(receiver, override, result);
    return result;
}

function matchesGlobs(file: string, patterns: string[]): boolean {
    for (let i = patterns.length - 1; i >= 0; --i) {
        const glob = isNegated(patterns[i]);
        const local = glob.pattern.startsWith('./');
        if (local)
            glob.pattern = glob.pattern.substr(2);
        if (new Minimatch(glob.pattern, {matchBase: !local}).match(file))
            return !glob.negated;
    }
    return false;
}

function getRulesDirectoriesByName(name: string, rulesDirectories: RulesDirectoryMap) {
    const slashIndex = name.lastIndexOf('/');
    return slashIndex === -1 ? undefined : rulesDirectories.get(name.substr(0, slashIndex));
}

function identityFn<T>(v: T): T {
    return v;
}

function arrayFn<T>(v: T): T[] {
    return [v];
}

function extendRulesDirectories<T extends string | string[]>(
    receiver: Map<string, string[]>,
    current: Map<string, T>,
    mapFn: (v: T) => string[],
    copy: boolean,
) {
    for (const [key, dir] of current) {
        const prev = receiver.get(key);
        if (prev !== undefined) {
            if (copy) {
                receiver.set(key, [...mapFn(dir), ...prev]);
            } else {
                prev.unshift(...mapFn(dir));
            }
        } else {
            receiver.set(key, mapFn(dir).slice());
        }
    }
    return receiver;
}

function extendConfig(
    receiver: Receiver,
    {processor, rules, settings}: Partial<Configuration | Configuration.Override>,
    r: ReduceResult,
) {
    if (processor !== undefined)
        r.processor = processor;
    if (rules) {
        for (const key of Object.keys(rules)) {
            const prev = receiver.rules.get(key);
            receiver.rules.set(key, {
                severity: 'error',
                options: undefined,
                ...prev,
                rulesDirectories: r.rulesDirectories && getRulesDirectoriesByName(key, r.rulesDirectories),
                ...resolveAlias(key, r.aliases),
                ...rules[key],
            });
        }
    }
    if (settings)
        extendSettings(settings, receiver.settings);
}

function extendSettings(settings: {[key: string]: any}, receiver: EffectiveConfiguration['settings']) {
    for (const key of Object.keys(settings))
        receiver.set(key, settings[key]);
}

function resolveAlias(rule: string, aliases: AliasMap | undefined) {
    let next = aliases && aliases.get(rule);
    if (!next)
        return { rule };
    const names = [];
    let startIndex = 0;
    const result: ResolvedAlias = {
        rule,
        rulesDirectories: undefined,
    };
    do {
        names.push(rule);
        if (next.rule === rule)
            throw new ConfigurationError(`Circular alias: ${names.join(' => ')} => ${next.rule}.`);
        if (next.aliases !== aliases) {
            startIndex = names.length - 1;
            aliases = next.aliases;
        } else if (names.includes(next.rule, startIndex)) {
            throw new ConfigurationError(`Circular alias: ${names.join(' => ')} => ${next.rule}.`);
        }
        result.rule = next.rule;
        result.rulesDirectories = next.rulesDirectories;
        if ('options' in next && !('options' in result))
            result.options = next.options;
        rule = next.rule;
        next = aliases.get(rule);
    } while (next);

    return result;
}

// @internal
export function getProcessorForFile(config: Configuration, fileName: string, cwd: string) {
    return findProcessorInConfig(config, path.resolve(cwd, fileName)) || undefined;
}

function findProcessorInConfig(config: Configuration, fileName: string): string | undefined | null | false {
    if (config.overrides) {
        const relative = path.relative(path.dirname(config.filename), fileName);
        for (let i = config.overrides.length - 1; i >= 0; --i) {
            const override = config.overrides[i];
            if (override.processor !== undefined && matchesGlobs(relative, override.files))
                return override.processor;
        }
    }
    if (config.processor !== undefined)
        return config.processor;
    for (let i = config.extends.length - 1; i >= 0; --i) {
        const processor = findProcessorInConfig(config.extends[i], fileName);
        if (processor !== undefined)
            return processor;
    }
    return;
}

// @internal
export function getSettingsForFile(config: Configuration, fileName: string, cwd: string): GlobalSettings {
    const result = new Map<string, any>();
    reduceSettings(config, path.resolve(cwd, fileName), result);
    return result;
}

function reduceSettings(config: Configuration, fileName: string, receiver: Map<string, any>) {
    for (const base of config.extends)
        reduceSettings(base, fileName, receiver);
    if (config.settings)
        extendSettings(config.settings, receiver);
    if (config.overrides) {
        const relative = path.relative(path.dirname(config.filename), fileName);
        for (const override of config.overrides)
            if (override.settings && matchesGlobs(relative, override.files))
                extendSettings(override.settings, receiver);
    }
}
