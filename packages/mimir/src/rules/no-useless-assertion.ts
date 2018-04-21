import { TypedRule, Replacement, typescriptOnly, excludeDeclarationFiles } from '@fimbul/ymir';
import * as ts from 'typescript';
import { isStrictNullChecksEnabled, isStrictPropertyInitializationEnabled } from '../utils';
import {
    isVariableDeclaration,
    hasModifier,
    isFunctionScopeBoundary,
    isObjectType,
    isNewExpression,
    isCallExpression,
    unionTypeParts,
} from 'tsutils';
import * as debug from 'debug';

const log = debug('wotan:rule:no-useless-assertion');

const FAIL_MESSAGE = "This assertion is unnecesary as it doesn't change the type of the expression.";
const FAIL_DEFINITE_ASSIGNMENT = 'This assertion is unnecessary as it has no effect on this declaration.';

const typescriptPre270 = /^2\.[456]\./.test(ts.version);
const typeFormat = ts.TypeFormatFlags.NoTruncation
    | ts.TypeFormatFlags.UseFullyQualifiedType
    | ts.TypeFormatFlags.WriteClassExpressionAsTypeLiteral
    | ts.TypeFormatFlags.UseStructuralFallback;

@excludeDeclarationFiles
@typescriptOnly
export class Rule extends TypedRule {
    private strictNullChecks = isStrictNullChecksEnabled(this.program.getCompilerOptions());

    public apply(): void {
        for (const node of this.context.getFlatAst()) {
            switch (node.kind) {
                case ts.SyntaxKind.NonNullExpression:
                    this.checkNonNullAssertion(<ts.NonNullExpression>node);
                    break;
                case ts.SyntaxKind.AsExpression:
                case ts.SyntaxKind.TypeAssertionExpression:
                    this.checkTypeAssertion(<ts.AssertionExpression>node);
                    break;
                case ts.SyntaxKind.VariableDeclaration:
                    this.checkDefiniteAssignmentAssertion(<ts.VariableDeclaration>node);
                    break;
                case ts.SyntaxKind.PropertyDeclaration:
                    this.checkDefiniteAssignmentAssertionProperty(<ts.PropertyDeclaration>node);
            }
        }
    }

    private checkDefiniteAssignmentAssertion(node: ts.VariableDeclaration) {
        // compiler already emits an error for definite assignment assertions on ambient or initialized variables
        if (node.exclamationToken !== undefined &&
            node.initializer === undefined && (
                !isStrictNullChecksEnabled(this.program.getCompilerOptions()) || // strictNullChecks need to be enabled
                getNullableFlags(this.checker.getTypeAtLocation(node.name), true) & ts.TypeFlags.Undefined // type does not allow undefined
            ))
            this.addFailure(
                node.exclamationToken.end - 1,
                node.exclamationToken.end,
                FAIL_DEFINITE_ASSIGNMENT,
                Replacement.delete(node.exclamationToken.pos, node.exclamationToken.end),
            );
    }

    private checkDefiniteAssignmentAssertionProperty(node: ts.PropertyDeclaration) {
        // compiler emits an error for definite assignment assertions on ambient, initialized or abstract properties
        if (node.exclamationToken !== undefined &&
            node.initializer === undefined &&
            !hasModifier(node.modifiers, ts.SyntaxKind.AbstractKeyword) && (
                node.name.kind !== ts.SyntaxKind.Identifier || // properties with string or computed name are not checked
                !isStrictPropertyInitializationEnabled(this.program.getCompilerOptions()) || // strictPropertyInitialization must be enabled
                getNullableFlags(this.checker.getTypeAtLocation(node), true) & ts.TypeFlags.Undefined // type does not allow undefined
            ))
            this.addFailure(
                node.exclamationToken.end - 1,
                node.exclamationToken.end,
                FAIL_DEFINITE_ASSIGNMENT,
                Replacement.delete(node.exclamationToken.pos, node.exclamationToken.end),
            );
    }

    private checkNonNullAssertion(node: ts.NonNullExpression) {
        let message = FAIL_MESSAGE;
        if (this.strictNullChecks) {
            const originalType = this.checker.getTypeAtLocation(node.expression);
            const flags = getNullableFlags(
                (!typescriptPre270 || originalType.flags & ts.TypeFlags.IndexedAccess) &&
                    this.checker.getBaseConstraintOfType(originalType) || originalType,
            );
            if (flags !== 0) { // type is nullable
                const contextualType = this.getSafeContextualType(node);
                if (contextualType === undefined || (flags & ~getNullableFlags(contextualType, true)))
                    return;
                message = `This assertion is unnecessary as the receiver accepts ${formatNullableFlags(flags)} values.`;
            }
            if (maybeUsedBeforeBeingAssigned(node.expression, originalType, this.checker)) {
                log('Identifier %s could be used before being assigned', node.expression.text);
                return;
            }
        }
        this.addFailure(node.end - 1, node.end, message, Replacement.delete(node.expression.end, node.end));
    }

    private checkTypeAssertion(node: ts.AssertionExpression) {
        let targetType = this.checker.getTypeAtLocation(node);
        if (targetType.flags & ts.TypeFlags.Literal || // allow "foo" as "foo" to avoid unnecessary widening
            isObjectType(targetType) && (targetType.objectFlags & ts.ObjectFlags.Tuple || couldBeTupleType(targetType)))
            return;
        let sourceType = this.checker.getTypeAtLocation(node.expression);
        // TODO remove assertion on update to typescript@2.8
        if ((targetType.flags & (ts.TypeFlags.TypeVariable | (<any>ts.TypeFlags).Instantiable)) === 0) {
            targetType = this.checker.getBaseConstraintOfType(targetType) || targetType;
            sourceType = this.checker.getBaseConstraintOfType(sourceType) || sourceType;
        }
        let message = FAIL_MESSAGE;
        if (!typesAreEqual(sourceType, targetType, this.checker)) {
            const contextualType = this.getSafeContextualType(node);
            if (contextualType === undefined || !typesAreEqual(sourceType, contextualType, this.checker))
                return;
            message = 'This assertion is unnecessary as the receiver accepts the original type of the expression.';
        }
        if (node.kind === ts.SyntaxKind.AsExpression) {
            this.addFailure(
                node.type.pos - 'as'.length,
                node.end,
                message,
                Replacement.delete(node.expression.end, node.end),
            );
        } else {
            const start = node.getStart(this.sourceFile);
            this.addFailure(start, node.expression.pos, message, Replacement.delete(start, node.expression.getStart(this.sourceFile)));
        }
    }

    /** Returns the contextual type if it is a position that does not contribute to control flow analysis. */
    private getSafeContextualType(node: ts.Expression): ts.Type | undefined {
        const parent = node.parent!;
        // If assertion is used as argument, check if the function accepts this expression without an assertion
        // TODO expand this to TemplateExpression, JsxExpression, etc
        if (!isCallExpression(parent) && !isNewExpression(parent) || node === parent.expression)
            return;
        return this.checker.getContextualType(node);
    }
}

function typesAreEqual(a: ts.Type, b: ts.Type, checker: ts.TypeChecker) {
    return a === b || checker.typeToString(a, undefined, typeFormat) === checker.typeToString(b, undefined, typeFormat);
}

function getNullableFlags(type: ts.Type, receiver?: boolean): ts.TypeFlags {
    let flags = 0;
    for (const t of unionTypeParts(type))
        flags |= t.flags;
    return ((receiver && flags & ts.TypeFlags.Any) ? -1 : flags) & (ts.TypeFlags.Null | ts.TypeFlags.Undefined);
}

function formatNullableFlags(flags: ts.TypeFlags) {
    switch (flags) {
        case ts.TypeFlags.Null: return "'null'";
        case ts.TypeFlags.Undefined: return "'undefined'";
        default: return "'null' and 'undefined'";
    }
}

/**
 * Determine if the assertion may be necessary to avoid a compile error for use before being assigned.
 * This function may yield some false negatives, but is needed until https://github.com/Microsoft/TypeScript/issues/20221 is implemented.
 *
 * The rules are as follows:
 * * strictNullChecks are enabled
 * * assertion is on an identifier
 * * identifier is a mutable variable
 * * no destructuring, parameters, catch binding, ambient declarations
 * * variable is not initialized
 * * variable has no definite assignment assertion (exclamation mark)
 * * variable has a type annotation
 * * declared type is equal to the type at the assertion
 * * declaration and assertion are in the same function scope
 *
 * We don't need to worry about strictPropertyInitialization errors, because they cannot be suppressed with a non-null assertion
 */
function maybeUsedBeforeBeingAssigned(node: ts.Expression, type: ts.Type, checker: ts.TypeChecker): node is ts.Identifier {
    if (node.kind !== ts.SyntaxKind.Identifier || getNullableFlags(type, true) & ts.TypeFlags.Undefined)
        return false;
    const symbol = checker.getSymbolAtLocation(node)!;
    const declaration = symbol.declarations![0];
    if (!isVariableDeclaration(declaration) ||
        declaration.parent!.kind !== ts.SyntaxKind.VariableDeclarationList ||
        declaration.initializer !== undefined ||
        declaration.exclamationToken !== undefined ||
        declaration.type === undefined ||
        declaration.parent!.parent!.kind === ts.SyntaxKind.VariableStatement &&
            hasModifier(declaration.parent!.parent!.modifiers, ts.SyntaxKind.DeclareKeyword))
        return false;
    if (!typesAreEqual(type, checker.getTypeFromTypeNode(declaration.type), checker))
        return false;
    return findupFunction(node.parent!.parent!.parent!) === findupFunction(declaration.parent!.parent!.parent!);
}

/** Finds the nearest parent that has a function scope. */
function findupFunction(node: ts.Node) {
    while (!isFunctionScopeBoundary(node) && node.kind !== ts.SyntaxKind.SourceFile)
        node = node.parent!;
    return node;
}

/**
 * Sometimes tuple types don't have ObjectFlags.Tuple set, like when they're being matched against an inferred type.
 * So, in addition, check if there are integer properties 0..n and no other numeric keys
 */
function couldBeTupleType(type: ts.ObjectType): boolean {
    const properties = type.getProperties();
    if (properties.length === 0)
        return false;
    let i = 0;
    for (; i < properties.length; ++i) {
        const name = properties[i].name;
        if (String(i) !== name) {
            if (i === 0)
                // if there are no integer properties, this is not a tuple
                return false;
            break;
        }
    }
    for (; i < properties.length; ++i)
        if (String(+properties[i].name) === properties[i].name)
            return false;
    return true;
}
