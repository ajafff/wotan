import { ConfigurableRule, excludeDeclarationFiles } from '@fimbul/ymir';
import * as ts from 'typescript';
import {
    isNumericLiteral,
    isBinaryExpression,
    isExpressionStatement,
    isVoidExpression,
    isForStatement,
    isIdentifier,
    isAssignmentKind,
} from 'tsutils';
import { hasDirectivePrologue } from '../utils';

export interface Options {
    allowNew: boolean;
    allowShortCircuit: boolean;
    allowTaggedTemplate: boolean;
    allowTernary: boolean;
}

const FAIL_MESSAGE = 'This expression is unused. Did you mean to assign a value or call a function?';

@excludeDeclarationFiles
export class Rule extends ConfigurableRule<Options> {
    public parseOptions(input: Partial<Options> | {} | null | undefined): Options {
        return {
            allowNew: false,
            allowShortCircuit: false,
            allowTaggedTemplate: false,
            allowTernary: false,
            ...input,
        };
    }

    public apply() {
        for (const node of this.context.getFlatAst()) {
            if (isBinaryExpression(node)) {
                if (node.operatorToken.kind === ts.SyntaxKind.CommaToken && !isIndirectEval(node))
                    this.checkNode(node.left);
            } else if (isExpressionStatement(node)) {
                // allow `void asyncFn()` to mute 'await-async-result'
                if (!isDirective(node) && node.expression.kind !== ts.SyntaxKind.VoidExpression)
                    this.checkNode(node.expression, node);
            } else if (isForStatement(node)) {
                if (node.initializer !== undefined && node.initializer.kind !== ts.SyntaxKind.VariableDeclarationList)
                    this.checkNode(node.initializer);
                if (node.incrementor !== undefined)
                    this.checkNode(node.incrementor);
            } else if (isVoidExpression(node) && !isAllowedVoidExpression(node.expression)) {
                this.checkNode(node.expression);
            }
        }
    }

    private checkNode(expr: ts.Expression, errorNode?: ts.Node) {
        if (!this.isUsed(expr))
            this.addFindingAtNode(errorNode ?? expr, FAIL_MESSAGE);
    }

    private isUsed(node: ts.Expression): boolean {
        switch (node.kind) {
            case ts.SyntaxKind.CallExpression:
            case ts.SyntaxKind.YieldExpression:
            case ts.SyntaxKind.AwaitExpression:
            case ts.SyntaxKind.DeleteExpression:
            case ts.SyntaxKind.PostfixUnaryExpression: // i++, i--
                return true;
            case ts.SyntaxKind.PrefixUnaryExpression:
                return (<ts.PrefixUnaryExpression>node).operator === ts.SyntaxKind.PlusPlusToken ||
                    (<ts.PrefixUnaryExpression>node).operator === ts.SyntaxKind.MinusMinusToken;
            case ts.SyntaxKind.NewExpression:
                return this.options.allowNew;
            case ts.SyntaxKind.TaggedTemplateExpression:
                return this.options.allowTaggedTemplate;
            case ts.SyntaxKind.ParenthesizedExpression:
                return this.isUsed((<ts.ParenthesizedExpression>node).expression);
            case ts.SyntaxKind.BinaryExpression: {
                const {operatorToken: {kind: tokenKind}, right} = <ts.BinaryExpression>node;
                switch (tokenKind) {
                    case ts.SyntaxKind.AmpersandAmpersandToken:
                    case ts.SyntaxKind.BarBarToken:
                        return this.options.allowShortCircuit && this.isUsed(right);
                    case ts.SyntaxKind.CommaToken:
                        return this.isUsed(right);
                    default:
                        return isAssignmentKind(tokenKind);
                }
            }
            case ts.SyntaxKind.ConditionalExpression: {
                if (!this.options.allowTernary)
                    return false;
                const {whenTrue, whenFalse} = <ts.ConditionalExpression>node;
                const whenTrueUsed = this.isUsed(whenTrue);
                const whenFalseUsed = this.isUsed(whenFalse);
                if (whenTrueUsed === whenFalseUsed)
                    return whenTrueUsed;
                this.addFindingAtNode(whenFalseUsed ? whenTrue : whenFalse, FAIL_MESSAGE);
                return true;
            }
            default:
                return false;
        }
    }
}

/**
 * A directive is an expression statement containing only a string literal.
 * Directives need to be located at the beginning of a function block and be consecutive.
 */
function isDirective(statement: ts.ExpressionStatement): boolean {
    if (statement.expression.kind !== ts.SyntaxKind.StringLiteral)
        return false;
    const parent = statement.parent!;
    if (!hasDirectivePrologue(parent))
        return false;
    for (let i = parent.statements.indexOf(statement) - 1; i >= 0; --i)
        if (parent.statements[i].kind !== ts.SyntaxKind.ExpressionStatement ||
            (<ts.ExpressionStatement>parent.statements[i]).expression.kind !== ts.SyntaxKind.StringLiteral)
            return false;
    return true;
}

/** `void 0` and `void(0)` are allowed to have no side effect. */
function isAllowedVoidExpression(expr: ts.Expression): boolean {
    if (expr.kind === ts.SyntaxKind.ParenthesizedExpression)
        expr = (<ts.ParenthesizedExpression>expr).expression;
    return isNumericLiteral(expr) && expr.text === '0';
}

/** Allow `(0, eval)('foo')` */
function isIndirectEval(node: ts.BinaryExpression): boolean {
    return isIdentifier(node.right) && node.right.text === 'eval' &&
        isNumericLiteral(node.left) && node.left.text === '0' &&
        node.parent!.kind === ts.SyntaxKind.ParenthesizedExpression &&
        node.parent!.parent!.kind === ts.SyntaxKind.CallExpression;
}
