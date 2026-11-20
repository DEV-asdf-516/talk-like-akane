#!/usr/bin/env node
// Verifies the npm tarball contents: runtime files present, dev-only files absent, no broken relative imports.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const REQUIRED = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'bin/talk-like-akane.mjs',
  'src/cli.mjs',
  'src/hook-runner.mjs',
  'src/render.mjs',
  'persona/persona.md',
  'persona/dialogues.md',
  'persona/locale-examples.md',
  'skills/talk-like-akane/SKILL.md',
];
export const FORBIDDEN = [/^tests\//, /^\.github\//, /^scripts\//, /^goal.*\.md$/i, /\.env/, /\.tgz$/, /node_modules/, /\.DS_Store/];

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function packFileList() {
  const out = execFileSync(npmCmd(), ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  const json = JSON.parse(out.slice(out.indexOf('[')));
  return json[0].files.map((f) => f.path.replace(/\\/g, '/'));
}

export function checkPack(files = packFileList()) {
  const problems = [];
  for (const r of REQUIRED) if (!files.includes(r)) problems.push(`missing from tarball: ${r}`);
  for (const f of files) for (const re of FORBIDDEN) if (re.test(f)) problems.push(`must not be published: ${f}`);
  // Every relative import inside shipped JS must resolve to a shipped file.
  for (const f of files.filter((x) => x.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/(?:import|export)[^'"]*from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const spec = m[1] ?? m[2];
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
      if (!files.includes(resolved)) problems.push(`${f} imports ${spec}, which is not in the tarball`);
    }
  }
  return { files, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { files, problems } = checkPack();
  console.log(`tarball files (${files.length}):\n  ${files.join('\n  ')}`);
  if (problems.length) {
    console.error(`\npack check FAILED:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\npack check OK');
}
