#!/usr/bin/env node
// Pre-publish gate used by .github/workflows/publish.yml. It fails until the publisher has filled in
// the metadata that must not be invented (license, repository) and the tag matches the version.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const problems = [];

if (pkg.name !== 'talk-like-akane') problems.push(`package name is "${pkg.name}", expected "talk-like-akane" (confirm any rename first)`);
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version)) problems.push(`version "${pkg.version}" is not SemVer`);
if (!pkg.license || pkg.license === 'UNLICENSED') problems.push('license is not set. The publisher must choose one (for example MIT) and add a LICENSE file');
if (pkg.license && pkg.license !== 'UNLICENSED' && !fs.existsSync(path.join(ROOT, 'LICENSE'))) problems.push('LICENSE file is missing');
if (!pkg.repository?.url) problems.push('package.json "repository" is missing. Add the real GitHub repository (required for npm Trusted Publishing and provenance)');
for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies']) if (pkg[k] && Object.keys(pkg[k]).length) problems.push(`runtime ${k} must stay empty`);
for (const k of ['preinstall', 'install', 'postinstall', 'prepare']) if (pkg.scripts?.[k]) problems.push(`lifecycle script "${k}" is not allowed`);
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
if (readme.includes('<!-- release-note:start -->')) problems.push('README.md still contains the pre-release "not published yet" note; remove the release-note block before publishing');
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## ${pkg.version}`)) problems.push(`CHANGELOG.md has no "## ${pkg.version}" section`);
if (changelog.includes(`## ${pkg.version} (unreleased)`)) problems.push(`CHANGELOG.md still marks ${pkg.version} as unreleased`);
const ref = process.env.GITHUB_REF_NAME;
if (process.env.GITHUB_REF_TYPE === 'tag' && ref !== `v${pkg.version}`) problems.push(`git tag ${ref} does not match package version v${pkg.version}`);

if (problems.length) {
  console.error(`release check FAILED:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`release check OK: ${pkg.name}@${pkg.version}`);
