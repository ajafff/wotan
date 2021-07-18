import { injectable } from 'inversify';
import * as ts from 'typescript';
import { getCommentAtPosition, WrappedAst, getWrappedNodeAtPosition } from 'tsutils';
import {
    FindingFilterFactory,
    FindingFilter,
    Finding,
    FindingFilterContext,
    LineSwitchParser,
    LineSwitchParserContext,
    RawLineSwitch,
    RawLineSwitchRule,
    FindingPosition,
    Severity,
    Replacement,
    CodeAction,
} from '@fimbul/ymir';

export const LINE_SWITCH_REGEX = /^ *wotan-(enable|disable)((?:-next)?-line)?( +(?:(?:[\w-]+\/)*[\w-]+ *, *)*(?:[\w-]+\/)*[\w-]+)? *$/;

const enum SwitchState {
    NoMatch,
    NoChange,
    Redundant,
    Unused,
    Used,
}
interface RuleSwitch {
    state: SwitchState;
    location?: ts.TextRange;
    fixLocation?: ts.TextRange;
}
interface Switch {
    location: ts.TextRange;
    enable: boolean;
    rules: RuleSwitch[];
    outOfRange: boolean;
}

@injectable()
export class LineSwitchFilterFactory implements FindingFilterFactory {
    constructor(private parser: LineSwitchParser) {}

    public create(context: FindingFilterContext): FindingFilter {
        const {disables, switches} = this.parseLineSwitches(context);
        return new Filter(disables, switches, context.sourceFile);
    }

    public getDisabledRanges(context: FindingFilterContext) {
        // remove internal `switch` property from ranges
        return new Map(Array.from(this.parseLineSwitches(context).disables, (entry): [string, ts.TextRange[]] => [
            entry[0],
            entry[1].map((range) => ({pos: range.pos, end: range.end})),
        ]));
    }

    private parseLineSwitches(context: FindingFilterContext) {
        const {sourceFile, ruleNames} = context;
        let wrappedAst: WrappedAst | undefined;
        const raw = this.parser.parse({
            sourceFile,
            getCommentAtPosition(pos) {
                const wrap = getWrappedNodeAtPosition(wrappedAst ??= context.getWrappedAst(), pos);
                if (wrap === undefined)
                    return;
                return getCommentAtPosition(sourceFile, pos, wrap.node);
            },
        });

        const lineSwitches = [];
        const result: DisableMap = new Map();
        for (const rawLineSwitch of raw) {
            const lineSwitch: Switch = {
                location: rawLineSwitch.location,
                enable: rawLineSwitch.enable,
                rules: [],
                outOfRange: rawLineSwitch.end! <= 0 || rawLineSwitch.pos > sourceFile.end,
            };
            lineSwitches.push(lineSwitch);
            if (lineSwitch.outOfRange)
                continue;
            const rulesToSwitch = new Map<string, RuleSwitch>();
            for (const rawRuleSwitch of rawLineSwitch.rules) {
                const ruleSwitch: RuleSwitch = {
                    location: rawRuleSwitch.location,
                    fixLocation: rawRuleSwitch.fixLocation || rawRuleSwitch.location,
                    state: SwitchState.NoMatch,
                };
                lineSwitch.rules.push(ruleSwitch);
                if (typeof rawRuleSwitch.predicate === 'string') {
                    if (ruleNames.includes(rawRuleSwitch.predicate)) {
                        if (rulesToSwitch.has(rawRuleSwitch.predicate)) {
                            ruleSwitch.state = SwitchState.Redundant;
                        } else {
                            rulesToSwitch.set(rawRuleSwitch.predicate, ruleSwitch);
                            ruleSwitch.state = SwitchState.NoChange;
                        }
                    }
                } else {
                    const matchingNames = ruleNames.filter(makeFilterPredicate(rawRuleSwitch.predicate));
                    if (matchingNames.length !== 0) {
                        ruleSwitch.state = SwitchState.Redundant;
                        for (const rule of matchingNames) {
                            if (!rulesToSwitch.has(rule)) {
                                rulesToSwitch.set(rule, ruleSwitch);
                                ruleSwitch.state = SwitchState.NoChange;
                            }
                        }
                    }
                }
            }
            for (const [rule, ruleSwitch] of rulesToSwitch) {
                const ranges = result.get(rule);
                if (ranges === undefined) {
                    if (rawLineSwitch.enable)
                        continue; // rule is already enabled
                    result.set(
                        rule,
                        [{pos: rawLineSwitch.pos, end: rawLineSwitch.end ?? Infinity, switch: ruleSwitch}],
                    );
                } else {
                    const last = ranges[ranges.length - 1];
                    if (last.end === Infinity) {
                        if (!rawLineSwitch.enable)
                            continue; // rule is already disabled
                        last.end = rawLineSwitch.pos;
                        if (rawLineSwitch.end !== undefined)
                            ranges.push({pos: rawLineSwitch.end, end: Infinity, switch: ruleSwitch});
                    } else if (rawLineSwitch.enable || rawLineSwitch.pos < last.end) {
                        // rule is already enabled
                        // or disabled range is nested inside the previous range
                        continue;
                    } else {
                        ranges.push({
                            pos: rawLineSwitch.pos,
                            end: rawLineSwitch.end ?? Infinity,
                            switch: ruleSwitch,
                        });
                    }
                }
                ruleSwitch.state = SwitchState.Unused;
            }
        }
        return {switches: lineSwitches, disables: result};
    }
}

interface DisabledRange extends ts.TextRange {
    switch: RuleSwitch;
}

type DisableMap = Map<string, DisabledRange[]>;

const stateText: Record<Exclude<SwitchState, SwitchState.Used>, (singular: boolean, mode: 'enable' | 'disable') => string> = {
    [SwitchState.NoChange](singular, mode) { return `${singular ? 'is' : 'are'} already ${mode}d`; },
    [SwitchState.NoMatch](singular) { return `do${singular ? 'es' : ''}n't match any rules enabled for this file`; },
    [SwitchState.Unused](singular) { return `${singular ? 'has' : 'have'} no failures to disable`; },
    [SwitchState.Redundant](singular, mode) { return singular ? `was already specified in this ${mode} switch` : 'are redundant'; },
};

class Filter implements FindingFilter {
    constructor(private disables: DisableMap, private switches: Switch[], private sourceFile: ts.SourceFile) {}

    public filter(finding: Finding) {
        const ruleDisables = this.disables.get(finding.ruleName);
        if (ruleDisables !== undefined) {
            const {start: {position: pos}, end: {position: end}} = finding;
            for (const disabledRange of ruleDisables) {
                if (end > disabledRange.pos && pos < disabledRange.end) {
                    disabledRange.switch.state = SwitchState.Used;
                    return false;
                }
            }
        }
        return true;
    }

    public reportUseless(severity: Severity) {
        const result: Finding[] = [];
        for (const current of this.switches) {
            const mode = current.enable ? 'enable' : 'disable';
            if (current.rules.length === 0) {
                result.push(
                    this.createFinding(
                        current.outOfRange
                            ? `${titlecase(mode)} switch has no effect. The specified range doesn't exits.`
                            : `${titlecase(mode)} switch doesn't specify any rule names.`,
                        severity,
                        current.location,
                    ),
                );
                continue;
            }
            const counts = new Array<number>(SwitchState.Used + 1).fill(0);
            for (const rule of current.rules)
                ++counts[rule.state];
            if (counts[SwitchState.Used] === 0 && (!current.enable || counts[SwitchState.Unused] === 0)) {
                const errorStates = [];
                for (let state = SwitchState.NoMatch; state !== SwitchState.Used; ++state)
                    if (counts[state] !== 0)
                        errorStates.push(stateText[state](false, mode));
                result.push(
                    this.createFinding(
                        `${titlecase(mode)} switch has no effect. All specified rules ${join(errorStates)}.`,
                        severity,
                        current.location,
                    ),
                );
                continue;
            }
            for (const ruleSwitch of current.rules)
                if (
                    ruleSwitch.location !== undefined &&
                    ruleSwitch.state !== SwitchState.Used &&
                    (!current.enable || ruleSwitch.state !== SwitchState.Unused)
                )
                    result.push(
                        this.createFinding(
                            `This rule ${stateText[ruleSwitch.state](true, mode)}.`,
                            severity,
                            ruleSwitch.location,
                            ruleSwitch.fixLocation,
                        ),
                    );
        }
        return result;
    }

    private createPosition(pos: number): FindingPosition {
        return {
            position: pos,
            ...ts.getLineAndCharacterOfPosition(this.sourceFile, pos),
        };
    }

    private createFinding(message: string, severity: Severity, location: ts.TextRange, fixLocation = location): Finding {
        return {
            ruleName: 'useless-line-switch',
            severity, // tslint:disable-line:object-shorthand-properties-first
            message, // tslint:disable-line:object-shorthand-properties-first
            start: this.createPosition(location.pos),
            end: this.createPosition(location.end),
            fix: CodeAction.create('Remove line switch', Replacement.delete(fixLocation.pos, fixLocation.end)),
            codeActions: undefined,
        };
    }
}

function titlecase(str: string) {
    return str.charAt(0).toUpperCase() + str.substr(1);
}

function join(parts: string[]): string {
    if (parts.length === 1)
        return parts[0];
    return parts.slice(0, -1).join(', ') + ' or ' + parts[parts.length - 1];
}

function makeFilterPredicate(
    predicate: Exclude<RawLineSwitchRule['predicate'], string>,
): Extract<RawLineSwitchRule['predicate'], Function> {
    return typeof predicate === 'function' ? predicate : (ruleName) => predicate.test(ruleName);
}

@injectable()
export class DefaultLineSwitchParser implements LineSwitchParser {
    public parse(context: LineSwitchParserContext) {
        const {sourceFile} = context;
        const result: RawLineSwitch[] = [];
        const commentRegex = /(\/[/*] *wotan-(enable|disable)((?:-next)?-line)?)( +(?:(?:[\w-]+\/)*[\w-]+ *, *)*(?:[\w-]+\/)*[\w-]+)? *(?:$|\*\/)/mg;

        for (let match = commentRegex.exec(sourceFile.text); match !== null; match = commentRegex.exec(sourceFile.text)) {
            const comment = context.getCommentAtPosition(match.index);
            if (comment === undefined || comment.pos !== match.index || comment.end !== match.index + match[0].length)
                continue;
            const rules = match[4] === undefined ? [{predicate: /^/}] : parseRules(match[4], match.index + match[1].length);
            const enable = match[2] === 'enable';
            switch (match[3]) {
                case '-line': {
                    const lineStarts = sourceFile.getLineStarts();
                    const {line} = ts.getLineAndCharacterOfPosition(sourceFile, comment.pos);
                    result.push({
                        rules,
                        enable,
                        pos: lineStarts[line],
                        // no need to switch back if there is no next line
                        end: lineStarts.length === line + 1 ? undefined : lineStarts[line + 1],
                        location: {pos: comment.pos, end: comment.end},
                    });
                    break;
                }
                case '-next-line': {
                    const lineStarts = sourceFile.getLineStarts();
                    const line = ts.getLineAndCharacterOfPosition(sourceFile, comment.pos).line + 1;
                    if (lineStarts.length === line) {
                        // there is no next line, return an out-of-range switch that can be reported
                        result.push({
                            rules,
                            enable,
                            pos: sourceFile.end + 1,
                            end: undefined,
                            location: {pos: comment.pos, end: comment.end},
                        });
                    } else {
                        result.push({
                            rules,
                            enable,
                            pos: lineStarts[line],
                            // no need to switch back if there is no next line
                            end: lineStarts.length === line + 1 ? undefined : lineStarts[line + 1],
                            location: {pos: comment.pos, end: comment.end},
                        });
                    }
                    break;
                }
                default:
                    result.push({rules, enable, pos: comment.pos, end: undefined, location: {pos: comment.pos, end: comment.end}});
            }
        }
        return result;
    }
}

function parseRules(raw: string, offset: number) {
    const result: RawLineSwitchRule[] = [];
    const re = /(?: *, *|$)/g;
    let pos = raw.search(/[^ ]/);
    let fixPos = pos;
    for (let match = re.exec(raw)!; ; match = re.exec(raw)!) {
        result.push({
            predicate: raw.slice(pos, match.index),
            location: {pos: pos + offset, end: match.index + offset},
            // fix of first rule needs to remove the comma after it, all other rule fixes need to remove the comma before it
            fixLocation: {pos: fixPos + offset, end: (result.length === 0 ? re.lastIndex : match.index) + offset},
        });
        if (match[0].length === 0)
            break;
        pos = re.lastIndex;
        fixPos = match.index; // fix always removes the preceeding comma
    }
    return result;
}
