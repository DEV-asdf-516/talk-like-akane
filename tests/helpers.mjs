// Test sandbox: an isolated HOME / PATH / data dir per test. Tests never touch the real user configuration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.mjs';
import * as P from '../src/paths.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(ROOT, 'bin', 'talk-like-akane.mjs');
export const IS_WIN = process.platform === 'win32';
const REAL_HOME = os.homedir();

export function makeSandbox({ claude = false, codex = false, claudeDir = false, codexDir = false, dataDirName } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-test-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const project = path.join(root, 'work', 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  if (path.resolve(home) === path.resolve(REAL_HOME)) throw new Error('sandbox home must not be the real home');
  const env = { HOME: home, USERPROFILE: home, PATH: bin };
  if (IS_WIN) {
    env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
    env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    env.SystemRoot = process.env.SystemRoot;
  }
  if (dataDirName) env.TALK_LIKE_AKANE_HOME = path.join(root, dataDirName);
  const sb = {
    root,
    home,
    bin,
    project,
    env,
    cwd: project,
    managedSettingsPaths: [path.join(root, 'managed', 'managed-settings.json')],
    codexRequirementsPaths: [path.join(root, 'managed', 'requirements.toml')],
    p: (...parts) => path.join(home, ...parts),
    addBinary(name) {
      fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      if (IS_WIN) fs.writeFileSync(path.join(bin, `${name}.cmd`), '@exit /b 0\r\n');
    },
    ctx(extra = {}) {
      return {
        env: { ...sb.env, ...(extra.env ?? {}) },
        home: sb.home,
        cwd: extra.cwd ?? sb.cwd,
        platform: process.platform,
        managedSettingsPaths: sb.managedSettingsPaths,
        codexRequirementsPaths: sb.codexRequirementsPaths,
        faultAfterOps: extra.faultAfterOps,
        now: extra.now,
      };
    },
    async run(argv, extra = {}) {
      let out = '';
      let err = '';
      const code = await main(argv, { ...sb.ctx(extra), out: (s) => (out += s), err: (s) => (err += s) });
      return { code, out, err };
    },
    spawn(argv, extra = {}) {
      const r = spawnSync(process.execPath, [BIN, ...argv], {
        cwd: extra.cwd ?? sb.cwd,
        env: { ...sb.env, ...(extra.env ?? {}) },
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { code: r.status, out: r.stdout, err: r.stderr };
    },
    dataDir() {
      return P.dataDir(sb.ctx());
    },
    read(...parts) {
      return fs.readFileSync(path.join(home, ...parts), 'utf8');
    },
    write(rel, content) {
      const f = path.isAbsolute(rel) ? rel : path.join(home, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
      return f;
    },
    readJson(...parts) {
      return JSON.parse(fs.readFileSync(path.join(home, ...parts), 'utf8'));
    },
    state() {
      const f = P.statePath(sb.ctx());
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  if (claude) sb.addBinary('claude');
  if (codex) sb.addBinary('codex');
  if (claudeDir) fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (codexDir) fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  return sb;
}

/** Map of relative path -> sha256 (files) or "<dir>" (directories); symlinks are recorded by target. */
export function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (e.isSymbolicLink()) out[rel] = `<link:${fs.readlinkSync(p)}>`;
      else if (e.isDirectory()) {
        out[rel] = '<dir>';
        walk(p);
      } else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

/** Execute a registered hook command the way a client would: through a shell, with JSON on stdin. */
export function runHookCommand(command, input, env = {}) {
  const r = spawnSync(command, {
    shell: true,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`, SystemRoot: process.env.SystemRoot, ...env },
    timeout: 20_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr, error: r.error };
}

export function ourHookCommand(hooksList, client) {
  const g = (hooksList ?? []).find((x) => x.hooks?.some((h) => h.command?.includes(`--client ${client} `)));
  return g?.hooks?.[0]?.command;
}

export const SOURCES = ['startup', 'resume', 'clear', 'compact', 'fork'];
