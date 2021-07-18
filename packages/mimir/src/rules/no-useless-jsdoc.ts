import { AbstractRule, typescriptOnly, Replacement } from '@fimbul/ymir';
import * as ts from 'typescript';
import { canHaveJsDoc, isJsDoc, getJsDoc } from 'tsutils';

@typescriptOnly
export class Rule extends AbstractRule {
    public apply() {
        for (const node of this.context.getFlatAst())
            if (canHaveJsDoc(node))
                this.checkNode(node);
    }

    private checkNode(node: ts.HasJSDoc) {
        const comments = node.kind === ts.SyntaxKind.EndOfFileToken
            ? ts.getJSDocTags(node).map((tag) => tag.parent!).filter(isJsDoc)
            : getJsDoc(node, this.sourceFile);
        if (comments.length === 0)
            return;
        if (node.kind === ts.SyntaxKind.EndOfFileToken || node.kind === ts.SyntaxKind.ParenthesizedExpression)
            return this.reportAllTags(comments);
        return this.checkComments(comments);
    }

    private checkComments(comments: readonly ts.JSDoc[]) {
        for (const comment of comments) {
            if (comment.tags === undefined)
                continue;
            const findings = comment.tags.map(checkTag);
            if (isEmptyComment(comment.comment) && findings.every((f) => f !== undefined && f.reason >= Reason.Tag)) {
                this.addFinding(
                    comment.pos,
                    comment.end,
                    'JSDoc comment only contains redundant tags.',
                    Replacement.delete(comment.pos, comment.end),
                );
                continue;
            }
            for (const finding of findings)
                if (finding !== undefined)
                    this.addFinding(
                        finding.range.pos,
                        finding.range.end,
                        `JSDoc ${describe(finding)} is redundant in TypeScript.`,
                        Replacement.delete(finding.range.pos, finding.range.end),
                    );
        }
    }

    private reportAllTags(comments: readonly ts.JSDoc[]) {
        for (const comment of comments) {
            if (comment.tags === undefined)
                continue;
            if (isEmptyComment(comment.comment)) {
                this.addFinding(
                    comment.pos,
                    comment.end,
                    'JSDoc comment has no effect here.',
                    Replacement.delete(comment.pos, comment.end),
                );
                continue;
            }
            for (const tag of comment.tags)
                this.addFinding(tag.pos, tag.end, 'JSDoc tag has no effect here.', Replacement.delete(tag.pos, tag.end));
        }
    }
}

function isEmptyComment(comment: ts.JSDoc['comment']) {
    return comment === undefined || comment.trim() === '';
}

const enum Reason {
    Type,
    Constraint,
    Tag,
    NoComment,
}

interface JsDocFinding {
    range: ts.TextRange;
    reason: Reason;
    name: ts.Identifier;
}

function describe(finding: JsDocFinding): string {
    switch (finding.reason) {
        case Reason.Type:
            return 'type annotation';
        case Reason.Constraint:
            return 'TypeParameter constraint';
        case Reason.Tag:
            return `tag '@${finding.name.text}'`;
        case Reason.NoComment:
            return `tag '@${finding.name.text}' without a description`;
    }
}

function checkTag(tag: ts.JSDocTag): JsDocFinding | undefined {
    switch (tag.kind) {
        case ts.SyntaxKind.JSDocTemplateTag:
        case ts.SyntaxKind.JSDocParameterTag:
        case ts.SyntaxKind.JSDocReturnTag: {
            if (isEmptyComment(tag.comment))
                return {range: tag, reason: Reason.NoComment, name: tag.tagName};
            const type = tag.kind === ts.SyntaxKind.JSDocTemplateTag
                ? (<ts.JSDocTemplateTag>tag).constraint
                : (<ts.JSDocParameterTag | ts.JSDocReturnTag>tag).typeExpression;
            return type !== undefined
                ? {range: type, reason: tag.kind === ts.SyntaxKind.JSDocTemplateTag ? Reason.Constraint : Reason.Type, name: tag.tagName}
                : undefined;
        }
        default:
            return isUselessTag(tag.tagName.text)
                ? {range: tag, reason: Reason.Tag, name: tag.tagName}
                : undefined;
    }
}

function isUselessTag(tagName: string) {
    switch (tagName) {
        case 'abstract':
        case 'virtual':
        case 'access':
        case 'private':
        case 'protected':
        case 'public':
        case 'async':
        case 'augments':
        case 'extends':
        case 'callback':
        case 'class':
        case 'constructor':
        case 'constant':
        case 'constructs':
        case 'enum':
        case 'exports':
        case 'external':
        case 'host':
        case 'function':
        case 'func':
        case 'method':
        case 'generator':
        case 'global':
        case 'implements':
        case 'interface':
        case 'instance':
        case 'member':
        case 'var':
        case 'memberof':
        case 'mixes':
        case 'mixin':
        case 'module':
        case 'name':
        case 'namespace':
        case 'property':
        case 'prop':
        case 'readonly':
        case 'requires':
        case 'static':
        case 'this':
        case 'type':
        case 'typedef':
        case 'yields':
        case 'yield':
            return true;
        default:
            return false;
    }
}
