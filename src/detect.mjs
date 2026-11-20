// Safe client detection: PATH lookup + config-directory existence. Never executes the client binaries.
import fs from 'node:fs';
import path from 'node:path';
import { getEnv, claudeHome, codexHome } from './paths.mjs';
import { isDirSync } from './util.mjs';

export function which(cmd, ctx) {
  const PATH = getEnv(ctx, 'PATH') || '';
  const win = ctx.platform === 'win32';
  const exts = win ? (getEnv(ctx, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const raw of PATH.split(path.delimiter)) {
    const dir = raw.replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    for (const ext of win ? [...exts, ''] : exts) {
      const p = path.join(dir, cmd + ext);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && (win || (st.mode & 0o111) !== 0)) return p;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

export function detectClients(ctx) {
  const cHome = claudeHome(ctx);
  const xHome = codexHome(ctx);
  const claudeBin = which('claude', ctx);
  const codexBin = which('codex', ctx);
  const claude = { binary: claudeBin, configDir: cHome, configDirExists: isDirSync(cHome) };
  const codex = { binary: codexBin, configDir: xHome, configDirExists: isDirSync(xHome) };
  claude.detected = !!(claude.binary || claude.configDirExists);
  codex.detected = !!(codex.binary || codex.configDirExists);
  return { claude, codex };
}

export function evidence(d) {
  const parts = [];
  if (d.binary) parts.push(`binary: ${d.binary}`);
  if (d.configDirExists) parts.push(`config: ${d.configDir}`);
  return parts.length ? parts.join('; ') : 'not found';
}
