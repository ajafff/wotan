import { AbstractRule, excludeDeclarationFiles } from '@fimbul/ymir';
import * as ts from 'typescript';
import {
    isBlockScopedVariableDeclarationList,
    hasModifier,
    isBlock,
    getControlFlowEnd,
    endsControlFlow,
    isLabeledStatement,
    hasExhaustiveCaseClauses,
} from 'tsutils';

type ForDoWhileStatement = ts.ForStatement | ts.WhileStatement | ts.DoStatement;

@excludeDeclarationFiles
export class Rule extends AbstractRule {
    public apply() {
        for (const node of this.context.getFlatAst()) {
            switch (node.kind) {
                case ts.SyntaxKind.Block:
                case ts.SyntaxKind.SourceFile:
                case ts.SyntaxKind.ModuleBlock:
                    this.checkBlock(<ts.BlockLike>node);
                    break;
                case ts.SyntaxKind.SwitchStatement:
                    this.checkSwitch(<ts.SwitchStatement>node);
                    break;
                case ts.SyntaxKind.IfStatement:
                    this.checkIfStatement(<ts.IfStatement>node);
                    break;
                case ts.SyntaxKind.ForStatement:
                case ts.SyntaxKind.WhileStatement:
                    this.checkConstantIterationCondition(<ForDoWhileStatement>node);
            }
        }
    }

    private checkSwitch(node: ts.SwitchStatement) {
        for (const clause of node.caseBlock.clauses) {
            this.checkBlock(clause);
            if (clause.kind === ts.SyntaxKind.DefaultClause) {
                const checker = this.program?.getTypeChecker();
                if (checker !== undefined && hasExhaustiveCaseClauses(node, checker))
                    this.addFindingAtNode(
                        clause.getFirstToken(this.sourceFile)!,
                        "'default' clause is unreachable in exhaustive 'switch' statements.",
                    );
            }
        }
    }

    private checkBlock(node: ts.BlockLike) {
        let i = node.statements.findIndex(this.nextStatementIsUnreachable, this);
        if (i === -1)
            return;
        for (i += 1; i < node.statements.length; ++i)
            if (isExecutableStatement(node.statements[i]))
                return this.report(node.statements[i]);
    }

    private checkIfStatement(node: ts.IfStatement) {
        switch (getConstantCondition(node.expression)) {
            case false:
                return this.report(node.thenStatement);
            case true:
                if (node.elseStatement !== undefined)
                    this.report(node.elseStatement);
        }
    }

    private checkConstantIterationCondition(node: ForDoWhileStatement) {
        if (getConstantIterationCondition(node) === false)
            this.report(node.statement);
    }

    private report(node: ts.Statement) {
        while (true) {
            if (isLabeledStatement(node)) {
                node = node.statement;
            } else if (isBlock(node)) {
                const next = node.statements.find(isExecutableStatement);
                if (next === undefined)
                    return;
                node = next;
            } else {
                break;
            }
        }
        this.addFindingAtNode(node.getFirstToken(this.sourceFile)!, 'Unreachable code detected.');
    }

    private nextStatementIsUnreachable(statement: ts.Statement, index: number, statements: readonly ts.Statement[]): boolean {
        if (index === statements.length - 1)
            return false; // no need to check the last statement in a block
        if (endsControlFlow(statement, this.program?.getTypeChecker()))
            return true;
        const labels: string[] = [];
        while (isLabeledStatement(statement)) {
            labels.push(statement.label.text);
            statement = statement.statement;
        }
        switch (statement.kind) {
            case ts.SyntaxKind.ForStatement:
            case ts.SyntaxKind.WhileStatement:
            case ts.SyntaxKind.DoStatement:
                // statements after loops, that go on forever without breaking, are never executed
                return getConstantIterationCondition(<ForDoWhileStatement>statement) === true &&
                    !getControlFlowEnd((<ts.IterationStatement>statement).statement).statements.some(
                        (jump) => jump.kind === ts.SyntaxKind.BreakStatement &&
                            (jump.label === undefined || labels.includes(jump.label.text)),
                    );
        }
        return false;
    }
}

function isExecutableStatement(node: ts.Statement): boolean {
    switch (node.kind) {
        case ts.SyntaxKind.FunctionDeclaration:
        case ts.SyntaxKind.InterfaceDeclaration:
        case ts.SyntaxKind.TypeAliasDeclaration:
        case ts.SyntaxKind.EmptyStatement:
            return false;
        case ts.SyntaxKind.EnumDeclaration:
            return !hasModifier(node.modifiers, ts.SyntaxKind.ConstKeyword);
        case ts.SyntaxKind.VariableStatement:
            return isBlockScopedVariableDeclarationList((<ts.VariableStatement>node).declarationList) ||
                (<ts.VariableStatement>node).declarationList.declarations.some((d) => d.initializer !== undefined);
        case ts.SyntaxKind.Block:
            return (<ts.Block>node).statements.some(isExecutableStatement);
        case ts.SyntaxKind.LabeledStatement:
            return isExecutableStatement((<ts.LabeledStatement>node).statement);
        default:
            return true;
    }
}

function getConstantIterationCondition(statement: ForDoWhileStatement) {
    return statement.kind === ts.SyntaxKind.ForStatement
        ? statement.condition === undefined || getConstantCondition(statement.condition)
        : getConstantCondition(statement.expression);
}

function getConstantCondition(node: ts.Expression) {
    switch (node.kind) {
        case ts.SyntaxKind.TrueKeyword:
            return true;
        case ts.SyntaxKind.FalseKeyword:
            return false;
        default:
            return;
    }
}
