import { AbstractRule, excludeDeclarationFiles } from '@fimbul/ymir';
import * as ts from 'typescript';
import { WrappedAst, getWrappedNodeAtPosition, isPropertyDeclaration, isStatementInAmbientContext, hasModifier } from 'tsutils';

@excludeDeclarationFiles
export class Rule extends AbstractRule {
    public apply() {
        let wrappedAst: WrappedAst | undefined;
        const {text} = this.sourceFile;
        const re = /\bstatic\b/g;

        for (let match = re.exec(text); match !== null; match = re.exec(text)) {
            const {node} = getWrappedNodeAtPosition(wrappedAst || (wrappedAst = this.context.getWrappedAst()), match.index)!;
            if (node.kind !== ts.SyntaxKind.StaticKeyword)
                continue;
            const member = node.parent!;
            if (
                isPropertyDeclaration(member) &&
                member.initializer === undefined &&
                member.questionToken === undefined &&
                // TODO move to tsutils as isAmbientPropertyDeclaration
                !hasModifier(member.modifiers, ts.SyntaxKind.DeclareKeyword) &&
                !(member.parent!.kind === ts.SyntaxKind.ClassDeclaration && isStatementInAmbientContext(member.parent!))
            )
                this.addFindingAtNode(member.name, "Non-optional 'static' property must be initialized.");
        }
    }
}
