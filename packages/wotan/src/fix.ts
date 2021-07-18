import * as ts from 'typescript';
import { CodeAction, Replacement } from '@fimbul/ymir';
import stableSort = require('stable');

export interface FixResult {
    result: string;
    fixed: number;
    range: ts.TextChangeRange;
}

/**
 * Tries to apply all fixes. The replacements of all fixes are sorted by index ascending.
 * They are then applied in order. If a replacement overlaps (or touches) the range of the previous replacement,
 * the process rolls back to the state before the first replacement of the offending fix was applied. The replacements
 * of this fix are not applied again.
 * At least one fix will be applied.
 */
export function applyFixes(source: string, fixes: readonly CodeAction[]): FixResult {
    interface FixWithState extends CodeAction {
        state: Record<'position' | 'index' | 'length', number> | undefined;
        skip: boolean;
    }
    let fixed = fixes.length;
    const replacements = [];
    for (const fix of fixes) {
        const state: FixWithState = {description: fix.description, replacements: combineReplacements(fix), skip: false, state: undefined};
        for (const replacement of state.replacements)
            replacements.push({fix: state, ...replacement});
    }
    const range: ts.TextChangeRange = {
        span: {
            start: 0,
            length: 0,
        },
        newLength: 0,
    };
    let output = '';
    let position = -1;
    replacements.sort(compareReplacements);
    for (let i = 0; i < replacements.length; ++i) {
        const replacement = replacements[i];
        const {fix} = replacement;
        if (fix.skip)
            continue; // there was a conflict, don't use replacements of this fix
        if (replacement.start <= position) {
            // ranges overlap (or have touching boundaries) -> don't fix to prevent unspecified behavior
            if (fix.state !== undefined) {
                // rollback to state before the first replacement of the fix was applied
                const rollbackToIndex = fix.state.index;
                for (--i; i !== rollbackToIndex; --i) { // this automatically resets `i` to the correct position
                    const f = replacements[i].fix;
                    // we need to reset all states of fixes that applied their first replacement after
                    // the first replacement of the just rolled back fix
                    if (f.state !== undefined && f.state.index === i)
                        f.state = undefined;
                    // retry all rolled back fixes, that applied their first replacement after the just rolled back fix
                    // unfortunately this doesn't take conflicting fixes into account, so we may roll it back later
                    if (f.state === undefined && f.skip) {
                        ++fixed;
                        f.skip = false;
                    }
                }
                output = output.substring(0, fix.state.length);
                position = fix.state.position;
            }
            fix.skip = true;
            --fixed;
            continue;
        }
        // save the current state to jump back if necessary
        if (fix.state === undefined && fix.replacements.length !== 1)
            fix.state = {position, index: i, length: output.length};
        if (position === -1) {
            // we are about to apply the first fix
            range.span.start = replacement.start;
            output = source.substring(0, replacement.start);
        } else {
            output += source.substring(position, replacement.start);
        }
        output += replacement.text;
        position = replacement.end;
    }
    output += source.substring(position);

    range.span.length = position - range.span.start;
    range.newLength = range.span.length + output.length - source.length;
    return {
        fixed,
        range,
        result: output,
    };
}

function compareReplacements(a: Replacement, b: Replacement): number {
    return a.start - b.start || a.end - b.end;
}

/** Combine adjacent replacements to avoid sorting replacements of other fixes between them. */
function combineReplacements(fix: CodeAction): ReadonlyArray<Replacement> {
    if (fix.replacements.length === 1)
        return fix.replacements;
    // use a stable sorting algorithm to avoid shuffling insertions at the same position as these have the same start and end values
    const replacements = stableSort.inplace(fix.replacements.slice(), compareReplacements);
    const result = [];
    let current = replacements[0];
    for (let i = 1; i < replacements.length; ++i) {
        const replacement = replacements[i];
        if (current.end > replacement.start)
            throw new Error(`Replacements of code action '${fix.description}' overlap.`);
        if (current.end === replacement.start) {
            current = {
                start: current.start,
                end: replacement.end,
                text: current.text + replacement.text,
            };
        } else {
            result.push(current);
            current = replacement;
        }
    }
    result.push(current);
    return result;
}
