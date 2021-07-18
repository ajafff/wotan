import * as ts from 'typescript';
import { isFunctionScopeBoundary, NodeWrap } from 'tsutils';
import { AbstractRule, excludeDeclarationFiles, CodeAction, Replacement } from '@fimbul/ymir';

@excludeDeclarationFiles
export class Rule extends AbstractRule {
    public apply() {
        return this.iterate(this.context.getWrappedAst().next, undefined);
    }

    private iterate(wrap: NodeWrap, end: NodeWrap | undefined) {
        do { // iterate as linked list until we find a generator
            if (wrap.kind === ts.SyntaxKind.Block && isGenerator(wrap.node.parent)) {
                if (!this.visitGeneratorBodyLookingForYield(wrap.next!, wrap.skip!))
                    this.fail(wrap.node.parent);
                wrap = wrap.skip!; // continue right after the function body
            } else {
                wrap = wrap.next!;
            }
        } while (wrap !== end);
    }

    private visitGeneratorBodyLookingForYield(wrap: NodeWrap, end: NodeWrap): boolean {
        let containsYield = false;
        while (wrap !== end) {
            if (wrap.node.kind === ts.SyntaxKind.YieldExpression)
                containsYield = true;
            if (isFunctionScopeBoundary(wrap.node)) {
                // can iterate as linked list again for nested functions
                this.iterate(wrap.next!, wrap.skip);
                wrap = wrap.skip!;
            } else {
                wrap = wrap.next!;
            }
        }
        return containsYield;
    }

    private fail({asteriskToken, name}: GeneratorDeclaration) {
        this.addFinding(
            asteriskToken.end - 1,
            asteriskToken.end,
            `Generator ${name === undefined ? '' : `'${name.getText(this.sourceFile).replace(/'/g, "\\'")}' `}contains no 'yield'.`,
            undefined,
            CodeAction.create(
                'Convert to regular function.',
                Replacement.replace(
                    asteriskToken.end - 1,
                    asteriskToken.end,
                    asteriskToken.pos < asteriskToken.end - 1 || name === undefined ? '' : ' ',
                ),
            ),
        );
    }
}

type GeneratorDeclaration = ts.FunctionLikeDeclaration & {asteriskToken: ts.AsteriskToken};

function isGenerator(node: ts.Node | undefined): node is GeneratorDeclaration {
    switch (node!.kind) {
        case ts.SyntaxKind.FunctionDeclaration:
        case ts.SyntaxKind.FunctionExpression:
        case ts.SyntaxKind.MethodDeclaration:
            return (<ts.FunctionLikeDeclaration>node).asteriskToken !== undefined;
        default:
            return false;
    }
}
