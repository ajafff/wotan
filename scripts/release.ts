import {
    getPackages,
    getChangedPackageNames,
    getLastRelaseTag,
    PackageData,
    writeManifest,
    execAndLog,
    ensureBranch,
    ensureCleanTree,
} from './util';
import * as semver from 'semver';

ensureBranch('master');
ensureCleanTree();

const rootManifest = require('../package.json');
const releaseVersion = rootManifest.version;
const version = new semver.SemVer(releaseVersion);
const isMajor = version.minor === 0 && version.patch === 0 && version.prerelease.length === 0 && version.build.length === 0;

const {packages, publicPackages} = getPackages();

const needsRelease = isMajor ? new Set<string>(packages.keys()) : getChangedPackageNames(getLastRelaseTag(), publicPackages.keys());

function updateManifest(path: string, manifest: PackageData, toVersion: string | undefined) {
    if (toVersion !== undefined)
        manifest.version = toVersion;
    for (const localName of needsRelease) {
        const {name} = packages.get(localName)!;
        if (manifest.dependencies && manifest.dependencies[name])
            manifest.dependencies[name] = `^${releaseVersion}`;
        if (manifest.peerDependencies && manifest.peerDependencies[name])
            manifest.peerDependencies[name] = `^${releaseVersion}`;
        if (manifest.devDependencies && manifest.devDependencies[name])
            manifest.devDependencies[name] = `^${releaseVersion}`;
    }
    writeManifest(path, manifest);
}

updateManifest('package.json', rootManifest, semver.inc(version, 'minor')!); // set root version to next minor version
for (const [name, manifest] of packages)
    updateManifest(`packages/${name}/package.json`, manifest, needsRelease.has(name) ? releaseVersion : undefined);

for (const [name, manifest] of packages) {
    if (!manifest.private && needsRelease.has(name)) {
        execAndLog(`npm publish packages/${name} --tag latest ${process.argv.slice(2).join(' ')}`);
        execAndLog(`npm dist-tag add ${manifest.name}@${manifest.version} next`);
    }
}
execAndLog(`git commit -a -m "v${releaseVersion}"`);
execAndLog(`git tag v${releaseVersion}`);
execAndLog(`git push origin master --tags`);
