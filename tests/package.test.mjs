import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, IS_WIN, runHookCommand, ourHookCommand, snapshot } from './helpers.mjs';
import { checkPack, packFileList } from '../scripts/pack-check.mjs';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const npm = IS_WIN ? 'npm.cmd' : 'npm';
const npx = IS_WIN ? 'npx.cmd' : 'npx';

test('package.json: name, bin, engines, files allowlist, zero runtime deps, no install scripts', () => {
  assert.equal(pkg.name, 'talk-like-akane');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(pkg.bin, { 'talk-like-akane': 'bin/talk-like-akane.mjs' });
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=22');
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('src/') && pkg.files.includes('persona/'));
  for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies']) assert.ok(!pkg[k] || Object.keys(pkg[k]).length === 0, k);
  for (const k of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']) assert.ok(!pkg.scripts?.[k], `no ${k} script`);
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].version, pkg.version, 'lockfile in sync');
  assert.deepEqual(Object.keys(lock.packages), [''], 'no dependencies in the lockfile');
});

test('bin entry has a node shebang and is executable', () => {
  const bin = path.join(ROOT, pkg.bin['talk-like-akane']);
  assert.ok(fs.readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node\n'));
  if (!IS_WIN) assert.ok(fs.statSync(bin).mode & 0o111, 'executable bit');
  const r = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), pkg.version);
});

test('npm pack contents: runtime files only, no tests/CI/goal docs, and no broken imports', () => {
  const { files, problems } = checkPack(packFileList());
  assert.deepEqual(problems, []);
  assert.ok(files.includes('src/hook-runner.mjs'));
  assert.ok(!files.some((f) => f.startsWith('tests/')));
});

test('no secrets, telemetry or network calls in shipped code', () => {
  const shipped = packFileList().filter((f) => /\.(mjs|md|json)$/.test(f));
  for (const f of shipped) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/(npm_[A-Za-z0-9]{36}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,}|xox[bp]-|AKIA[0-9A-Z]{16})/.test(t), `token-like string in ${f}`);
    if (f.endsWith('.mjs')) {
      assert.ok(!/\bfetch\(|node:https?['"]|node:net['"]|node:dgram|XMLHttpRequest|WebSocket/.test(t), `network usage in ${f}`);
      assert.ok(!/telemetry|analytics|sentry|posthog/i.test(t), `telemetry in ${f}`);
      assert.ok(!/curl |wget |git clone|sudo /.test(t), `shell download/elevation in ${f}`);
    }
  }
});

test('tarball E2E through npx: install, set-level, status, then the hook keeps working after the npx cache is deleted, then uninstall', { timeout: 180_000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tla-pack-'));
  try {
    const packDir = path.join(tmp, 'pack');
    fs.mkdirSync(packDir);
    const pack = spawnSync(npm, ['pack', '--pack-destination', packDir, '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', shell: IS_WIN });
    assert.equal(pack.status, 0, pack.stderr);
    const tgz = path.join(packDir, JSON.parse(pack.stdout.slice(pack.stdout.indexOf('[')))[0].filename);
    const home = path.join(tmp, 'home');
    const bin = path.join(tmp, 'bin');
    const cache = path.join(tmp, 'npm-cache');
    const work = path.join(tmp, 'work');
    for (const d of [home, bin, work]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'claude.cmd'), '@exit /b 0\r\n');
    fs.mkdirSync(path.join(home, '.codex'));
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|Path|SystemRoot|ComSpec|PATHEXT|TEMP|TMP|TMPDIR|APPDATA|ProgramData)$/i.test(k))),
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      npm_config_cache: cache,
      npm_config_offline: 'true',
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    };
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    env[pathKey] = `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${env[pathKey] ?? ''}`;
    for (const k of ['XDG_DATA_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TALK_LIKE_AKANE_HOME']) delete env[k];
    const run = (...args) => spawnSync(npx, ['-y', `--package=${tgz}`, 'talk-like-akane', ...args], { cwd: work, env, encoding: 'utf8', shell: IS_WIN, timeout: 120_000 });

    const before = snapshot(home);
    const inst = run();
    assert.equal(inst.status, 0, `${inst.stdout}\n${inst.stderr}`);
    assert.match(inst.stdout, /Claude Code/);
    assert.match(inst.stdout, /Codex/);
    const lvl = run('set-level', '5');
    assert.equal(lvl.status, 0, lvl.stderr);
    const st = run('status', '--json');
    assert.equal(st.status, 0, st.stderr);
    const report = JSON.parse(st.stdout);
    assert.equal(report.installs[0].level, 5);
    assert.equal(report.installs[0].targets.claude.outputStyle.state, 'ACTIVE');

    // Remove the npx cache and the tarball. The installed hook must not depend on either.
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(packDir, { recursive: true, force: true });
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    const cmd = ourHookCommand(settings.hooks.SessionStart, 'claude');
    assert.ok(!cmd.includes('_npx') && !cmd.includes(cache), 'hook does not point into the npx cache');
    const hook = runHookCommand(cmd, { hook_event_name: 'SessionStart', source: 'startup', session_id: 'e2e' });
    assert.equal(hook.code, 0, hook.err);
    assert.match(JSON.parse(hook.out).hookSpecificOutput.additionalContext, /teasing level 5\/5/);
    const codexCmd = ourHookCommand(JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8')).hooks.SessionStart, 'codex');
    assert.equal(runHookCommand(codexCmd, { hook_event_name: 'SessionStart', source: 'resume' }).code, 0);

    // Uninstall straight from the source tree this time (the tarball is gone), with the same HOME.
    const un = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'talk-like-akane.mjs'), 'uninstall'], { cwd: work, env, encoding: 'utf8' });
    assert.equal(un.status, 0, un.stderr);
    const after = snapshot(home);
    const leftovers = Object.keys(after).filter((k) => !(k in before) && !/^(\.npm|Library$|Library[\\/]Application Support$|\.local$|\.local[\\/]share$|AppData$|AppData[\\/]Local$)/.test(k));
    assert.deepEqual(leftovers, [], 'uninstall leaves nothing behind');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
