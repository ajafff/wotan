import { injectable } from 'inversify';
import { TypedRule, TypedRuleContext, FlattenedAst } from '../types';
import {
    isElementAccessExpression,
    isIdentifier,
    isPropertyAccessExpression,
    getUsageDomain,
    isCallExpression,
    isNewExpression,
    isTaggedTemplateExpression,
    isJsxOpeningLikeElement,
    isUnionType,
    isObjectBindingPattern,
    getPropertyName,
    isPropertyAssignment,
    isReassignmentTarget,
    isShorthandPropertyAssignment,
} from 'tsutils';
import * as ts from 'typescript';

const functionLikeSymbol = ts.SymbolFlags.Function | ts.SymbolFlags.Method;

@injectable()
export class Rule extends TypedRule {
    constructor(context: TypedRuleContext, private flatAst: FlattenedAst) {
        super(context);
    }

    public apply() {
        for (const node of this.flatAst) {
            // TODO maybe check Type["property"]
            if (isPropertyAccessExpression(node)) {
                this.checkDeprecation(node, node.name.text);
            } else if (isElementAccessExpression(node)) {
                this.checkElementAccess(node);
            } else if (isIdentifier(node)) {
                if (shouldCheckIdentifier(node))
                    this.checkDeprecation(node, node.text);
            } else if (
                isCallExpression(node) ||
                isNewExpression(node) ||
                isTaggedTemplateExpression(node) ||
                ts.isDecorator(node) ||
                isJsxOpeningLikeElement(node)
            ) {
                this.checkSignature(node);
            } else if (node.kind === ts.SyntaxKind.QualifiedName) {
                if (shouldCheckQualifiedName(node))
                    this.checkDeprecation(node, node.right.text);
            } else if (isObjectBindingPattern(node)) {
                this.checkObjectBindingPattern(node);
            } else if (isPropertyAssignment(node)) {
                if (node.name.kind === ts.SyntaxKind.Identifier && isReassignmentTarget(node.parent))
                    this.checkObjectDestructuring(node.name);
            } else if (isShorthandPropertyAssignment(node) && isReassignmentTarget(node.parent)) {
                this.checkObjectDestructuring(node.name);
            }
        }
    }

    private checkObjectDestructuring(node: ts.Identifier) {
        const symbol = this.checker.getPropertySymbolOfDestructuringAssignment(node);
        if (symbol !== undefined)
            return this.checkForDeprecation(symbol, node, node.text, describeWithName);
    }

    private checkDeprecation(node: ts.Node, name: string) {
        let symbol = this.checker.getSymbolAtLocation(node);
        if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias)
            symbol = this.checker.getAliasedSymbol(symbol);
        if (symbol === undefined || (symbol.flags & functionLikeSymbol) && isPartOfCall(node))
            return;
        return this.checkForDeprecation(symbol, node, name, describeWithName);
    }

    private checkSignature(node: ts.CallLikeExpression) {
        const signature = this.checker.getResolvedSignature(node);
        if (signature !== undefined) // for compatibility with typescript@<2.6.0
            return this.checkForDeprecation(signature, node, undefined, signatureToString);
    }

    private checkObjectBindingPattern(node: ts.ObjectBindingPattern) {
        const type = this.checker.getTypeAtLocation(node);
        for (const element of node.elements) {
            if (element.dotDotDotToken !== undefined)
                continue;
            if (element.propertyName === undefined) {
                const name = (<ts.Identifier>element.name).text;
                const symbol = type.getProperty(name);
                if (symbol !== undefined)
                    this.checkForDeprecation(symbol, element.name, name, describeWithName);
            } else {
                const name = getPropertyName(element.propertyName);
                if (name !== undefined) {
                    const symbol = type.getProperty(name);
                    if (symbol !== undefined)
                        this.checkForDeprecation(symbol, element.propertyName, name, describeWithName);
                } else {
                    const propType = this.checker.getTypeAtLocation((<ts.ComputedPropertyName>element.propertyName).expression);
                    this.checkDynamicPropertyAccess(type, propType, element.propertyName);
                }
            }
        }
    }

    private checkElementAccess(node: ts.ElementAccessExpression) {
        if (node.argumentExpression === undefined)
            return;
        const type = this.checker.getTypeAtLocation(node.expression);
        const keyType = this.checker.getTypeAtLocation(node.argumentExpression);
        this.checkDynamicPropertyAccess(type, keyType, node);
    }

    private checkDynamicPropertyAccess(type: ts.Type, keyType: ts.Type, node: ts.Node) {
        for (const t of isUnionType(keyType) ? keyType.types : [keyType]) {
            if (t.flags & ts.TypeFlags.StringOrNumberLiteral) {
                const name = String((<ts.StringLiteralType | ts.NumberLiteralType>t).value);
                const symbol = type.getProperty(name);
                if (symbol !== undefined && ((symbol.flags & functionLikeSymbol) === 0 || !isPartOfCall(node)))
                    this.checkForDeprecation(symbol, node, name, describeWithName);
            }
        }
    }

    private checkForDeprecation<T extends ts.Signature | ts.Symbol, U extends ts.Node, V>(
        s: T,
        node: U,
        hint: V,
        descr: (s: T, node: U, checker: ts.TypeChecker, hint: V) => string,
    ) {
        for (const tag of s.getJsDocTags())
            if (tag.name === 'deprecated')
                this.addFailureAtNode(
                    node,
                    `${descr(s, node, this.checker, hint)} is deprecated${tag.text ? ': ' + tag.text : '.'}`,
                );
    }
}

function describeWithName(symbol: ts.Symbol, _n: ts.Node, _c: ts.TypeChecker, name: string) {
    return `${describeSymbol(symbol)} '${name}'`;
}

function describeSymbol(symbol: ts.Symbol): string {
    if (symbol.flags & ts.SymbolFlags.Variable)
        return 'Variable';
    if (symbol.flags & ts.SymbolFlags.PropertyOrAccessor)
        return 'Property';
    if (symbol.flags & ts.SymbolFlags.Class)
        return 'Class';
    if (symbol.flags & ts.SymbolFlags.Enum)
        return 'Enum';
    if (symbol.flags & ts.SymbolFlags.EnumMember)
        return 'EnumMember';
    if (symbol.flags & ts.SymbolFlags.Function)
        return 'Function';
    if (symbol.flags & ts.SymbolFlags.Method)
        return 'Method';
    if (symbol.flags & ts.SymbolFlags.Interface)
        return 'Interface';
    if (symbol.flags & ts.SymbolFlags.NamespaceModule)
        return 'Namespace';
    if (symbol.flags & ts.SymbolFlags.TypeAlias)
        return 'TypeAlias';
    return '(unknown)';
}

function signatureToString(signature: ts.Signature, n: ts.CallLikeExpression, checker: ts.TypeChecker) {
    const construct = n.kind === ts.SyntaxKind.NewExpression ||
        n.kind === ts.SyntaxKind.CallExpression && n.expression.kind === ts.SyntaxKind.SuperKeyword;
    return `${construct ? 'Costruct' : 'Call'}Signature '${construct ? 'new ' : ''}${checker.signatureToString(signature)}'`;
}

function isPartOfCall(node: ts.Node) {
    while (true) {
        const parent = node.parent!;
        switch (parent.kind) {
            case ts.SyntaxKind.TaggedTemplateExpression:
            case ts.SyntaxKind.Decorator:
                return true;
            case ts.SyntaxKind.CallExpression:
                // note: NewExpression will never get here, because if the class is deprecated, we show an error all the time
                return (<ts.CallExpression>parent).expression === node;
            case ts.SyntaxKind.JsxOpeningElement:
            case ts.SyntaxKind.JsxSelfClosingElement:
                return (<ts.JsxOpeningLikeElement>parent).tagName === node;
            case ts.SyntaxKind.ParenthesizedExpression:
                node = parent;
                break;
            default:
                return false;
        }
    }
}

function shouldCheckIdentifier(node: ts.Identifier): boolean {
    switch (node.parent!.kind) {
        case ts.SyntaxKind.ImportEqualsDeclaration:
        case ts.SyntaxKind.ExportAssignment:
        case ts.SyntaxKind.ExportSpecifier:
        case ts.SyntaxKind.JsxClosingElement:
            return false;
        default:
            return getUsageDomain(node) !== undefined;
    }
}

function shouldCheckQualifiedName(node: ts.Node): node is ts.QualifiedName {
    // if parent is a QualifiedName, it is the my.ns part of my.ns.Something -> we definitely want to check that
    // if the parent is an ImportEqualsDeclaration -> we don't want to check the rightmost identifier, because importing is not that bad
    // everything else is a TypeReference -> we want to check that
    return node.parent!.kind !== ts.SyntaxKind.ImportEqualsDeclaration;
}
