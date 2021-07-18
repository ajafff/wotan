import * as ts from 'typescript';
import { CodeAction } from '@fimbul/ymir';
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
export declare function applyFixes(source: string, fixes: readonly CodeAction[]): FixResult;
