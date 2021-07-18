import {
    AbstractProcessor,
    ProcessorUpdateResult,
    Finding,
    Replacement,
    ProcessorSuffixContext,
    ProcessorContext,
    FindingPosition,
    CodeAction,
} from '@fimbul/ymir';
import * as path from 'path';
import * as SAXParser from 'parse5-sax-parser';
import * as ts from 'typescript';
import * as voidElements from 'void-elements';

export class Processor extends AbstractProcessor {
    public static getSuffixForFile(context: ProcessorSuffixContext) {
        if (path.extname(context.fileName) !== '.vue')
            return '';
        let suffix = '';
        const parser = new SAXParser();
        let depth = 0;
        parser.on('startTag', (startTag) => {
            if (startTag.selfClosing || voidElements[startTag.tagName])
                return;
            ++depth;
            if (depth === 1 && startTag.tagName === 'script') {
                const lang = startTag.attrs.find((attr) => attr.name === 'lang');
                suffix = lang === undefined ? '.js' : `.${lang.value}`;
            }
        });
        parser.on('endTag', () => {
            --depth;
        });
        parser.write(context.readFile());
        parser.end();
        return suffix;
    }

    private range = {
        start: 0,
        end: Infinity,
        line: 0,
        firstLineOffset: 0,
    };

    constructor(context: ProcessorContext) {
        super(context);
        if (path.extname(this.sourceFileName) === '.vue') {
            const parser = new SAXParser({sourceCodeLocationInfo: true});
            let depth = 0;
            parser.on('startTag', (startTag) => {
                if (startTag.selfClosing || voidElements[startTag.tagName])
                    return;
                ++depth;
                if (depth === 1 && startTag.tagName === 'script')
                    this.range.start = startTag.sourceCodeLocation!.endOffset;
            });
            parser.on('endTag', (endTag) => {
                --depth;
                if (depth === 0 && endTag.tagName === 'script')
                    this.range.end = endTag.sourceCodeLocation!.startOffset;
            });
            parser.write(this.source);
            parser.end();
            const lineBreakAfterStart = /^\r?\n/.exec(this.source.substr(this.range.start));
            if (lineBreakAfterStart !== null) {
                this.range.start += lineBreakAfterStart[0].length;
            } else {
                let lineBreakBeforeStart = this.source.lastIndexOf('\n', this.range.start);
                if (lineBreakBeforeStart === -1)
                    lineBreakBeforeStart = 0;
                this.range.firstLineOffset = this.range.start - lineBreakBeforeStart;
            }
            const match = this.source.substring(0, this.range.start).match(/(\r?\n)/g);
            if (match !== null)
                this.range.line = match.length;
        }
    }

    public preprocess() {
        return this.source.substring(this.range.start, this.range.end);
    }

    public updateSource(newSource: string, changeRange: ts.TextChangeRange): ProcessorUpdateResult {
        const diff = newSource.length - this.source.length;
        this.range.end += diff;
        this.source = newSource;
        return {
            transformed: this.preprocess(),
            changeRange: {
                span: {
                    start: changeRange.span.start - this.range.start,
                    length: changeRange.span.length,
                },
                newLength: changeRange.newLength,
            },
        };
    }

    public postprocess(findings: Finding[]): Finding[] {
        return findings.map(this.mapFinding, this);
    }

    private mapFinding(f: Finding): Finding {
        return {
            ...f,
            start: this.adjustPosition(f.start),
            end: this.adjustPosition(f.end),
            fix: f.fix === undefined
                ? undefined
                : {
                    description: f.fix.description,
                    replacements: f.fix.replacements.map(this.mapReplacement, this),
                },
            codeActions: f.codeActions?.map(this.mapCodeAction, this),
        };
    }

    private adjustPosition(pos: FindingPosition): FindingPosition {
        return {
            // special handling for first line if there is no line break after opening tag
            character: pos.line === 0 ? pos.character + this.range.firstLineOffset : pos.character,
            line: pos.line + this.range.line,
            position: pos.position + this.range.start,
        };
    }

    private mapReplacement(r: Replacement): Replacement {
        return {
            start: r.start + this.range.start,
            end: r.end + this.range.start,
            text: r.text,
        };
    }

    private mapCodeAction(c: CodeAction): CodeAction {
        return {
            description: c.description,
            replacements: c.replacements.map(this.mapReplacement, this),
        };
    }
}
