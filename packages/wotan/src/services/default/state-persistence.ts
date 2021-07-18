import { injectable } from 'inversify';
import { CachedFileSystem } from '../cached-file-system';
import debug = require('debug');
import * as yaml from 'js-yaml';
import { StatePersistence, StaticProgramState } from '@fimbul/ymir';

const log = debug('wotan:statePersistence');

interface CacheFileContent {
    v: number;
    state: StaticProgramState;
}

const CACHE_VERSION = 1;

@injectable()
export class DefaultStatePersistence implements StatePersistence {
    constructor(private fs: CachedFileSystem) {}

    public loadState(project: string): StaticProgramState | undefined {
        const fileName = buildFilename(project);
        if (!this.fs.isFile(fileName))
            return;
        try {
            log("Loading cache from '%s'", fileName);
            const content = <CacheFileContent | undefined>yaml.load(this.fs.readFile(fileName));
            if (content?.v !== CACHE_VERSION) {
                log("Version mismatch: expected '%s', actual: '%s'", CACHE_VERSION, content?.v);
                return;
            }
            return rebuildState(content.state);
        } catch {
            log("Error loading cache '%s'", fileName);
            return;
        }
    }

    public saveState(project: string, state: StaticProgramState) {
        const fileName = buildFilename(project);
        log("Writing cache '%s'", fileName);
        try {
            const content: CacheFileContent = {state, v: CACHE_VERSION};
            this.fs.writeFile(fileName, yaml.dump(content, {indent: 2, sortKeys: true}));
        } catch {
            log("Error writing cache '%s'", fileName);
        }
    }
}

/** Ensures properties are in the same order and properties with undefined value are added back */
function rebuildState(state: StaticProgramState): StaticProgramState {
    return {
        files: state.files.map((f) => !f.result?.length ? f : {...f, result: f.result.map((finding) => ({
            ruleName: finding.ruleName,
            severity: finding.severity,
            message: finding.message,
            start: finding.start,
            end: finding.end,
            fix: finding.fix,
            codeActions: finding.codeActions,
        }))}),
        lookup: state.lookup,
        v: state.v,
        ts: state.ts,
        cs: state.cs,
        global: state.global,
        options: state.options,
    };
}

function buildFilename(tsconfigPath: string) {
    return tsconfigPath.replace(/.[^.]+$/, '.fimbullintercache');
}
