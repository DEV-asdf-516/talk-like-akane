import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, snapshot, runHookCommand, ourHookCommand, IS_WIN } from './helpers.mjs';
import { buildHookCommand, HOOK_TAG } from '../src/hooks.mjs';

const OTHER_START = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo other-tool', timeout: 5 }] };

test('existing SessionStart hooks (and other events) are preserved; only ours is added and removed', async () => {
  const sb = makeSandbox({ claude: true, codex: true });
  try {
    const claudeOrig = JSON.stringify({ hooks: { SessionStart: [OTHER_START], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] }, model: 'x' }, null, 2) + '\n';
    const codexOrig = JSON.stringify({ description: 'mine', hooks: { SessionStart: [OTHER_START], Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] } }, null, 2) + '\n';
    sb.write('.claude/settings.json', claudeOrig);
    sb.write('.codex/hooks.json', codexOrig);
    assert.equal((await sb.run([])).code, 0);
    for (const [rel, client] of [[['.claude', 'settings.json'], 'claude'], [['.codex', 'hooks.json'], 'codex']]) {
      const j = sb.readJson(...rel);
      assert.equal(j.hooks.SessionStart.length, 2);
      assert.deepEqual(j.hooks.SessionStart[0], OTHER_START, 'foreign hook untouched and first');
      assert.equal(j.hooks.SessionStart[1].matcher, 'startup|resume|clear|compact|fork');
      assert.equal(j.hooks.SessionStart[1].hooks[0].type, 'command');
      assert.ok(j.hooks.SessionStart[1].hooks[0].command.includes(`--client ${client} `));
      assert.ok(j.hooks.SessionStart[1].hooks[0].command.includes(HOOK_TAG));
      // No per-prompt or Stop rewriting hooks are ever registered.
      assert.ok(!JSON.stringify(j.hooks.UserPromptSubmit ?? []).includes('talk-like-akane'));
      assert.ok(!JSON.stringify(j.hooks.Stop ?? []).includes('talk-like-akane'));
    }
    assert.equal(sb.readJson('.claude', 'settings.json').hooks.PreToolUse[0].hooks[0].command, 'guard');
    // Re-running, updating and changing the level never duplicates the entry.
    for (const argv of [[], ['update'], ['set-level', '1'], ['set-language', 'ja']]) assert.equal((await sb.run(argv)).code, 0);
    assert.equal(sb.readJson('.claude', 'settings.json').hooks.SessionStart.length, 2);
    assert.equal(sb.readJson('.codex', 'hooks.json').hooks.SessionStart.length, 2);
    assert.equal((await sb.run(['uninstall'])).code, 0);
    assert.equal(sb.read('.claude', 'settings.json'), claudeOrig);
    assert.equal(sb.read('.codex', 'hooks.json'), codexOrig);
  } finally {
    sb.cleanup();
  }
});

test('hooks.json created by us is deleted on uninstall; an existing empty SessionStart array survives', async () => {
  const a = makeSandbox({ codex: true });
  const b = makeSandbox({ codex: true });
  try {
    assert.equal((await a.run([])).code, 0);
    assert.ok(fs.existsSync(a.p('.codex', 'hooks.json')));
    assert.equal((await a.run(['uninstall'])).code, 0);
    assert.ok(!fs.existsSync(a.p('.codex', 'hooks.json')));

    b.write('.codex/hooks.json', '{\n\t"hooks": {\n\t\t"SessionStart": []\n\t}\n}\n');
    assert.equal((await b.run([])).code, 0);
    assert.match(b.read('.codex', 'hooks.json'), /^\t"hooks"/m, 'tab indentation kept');
    // Someone else changes another key afterwards. Uninstall must keep that change.
    const j = b.readJson('.codex', 'hooks.json');
    j.hooks.Stop = [{ hooks: [{ type: 'command', command: 'later' }] }];
    b.write('.codex/hooks.json', JSON.stringify(j, null, '\t') + '\n');
    assert.equal((await b.run(['uninstall'])).code, 0);
    assert.deepEqual(b.readJson('.codex', 'hooks.json'), { hooks: { SessionStart: [], Stop: [{ hooks: [{ type: 'command', command: 'later' }] }] } });
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('CRLF settings files stay CRLF', async () => {
  const sb = makeSandbox({ claude: true });
  try {
    sb.write('.claude/settings.json', '{\r\n  "model": "opus"\r\n}\r\n');
    assert.equal((await sb.run([])).code, 0);
    const t = sb.read('.claude', 'settings.json');
    assert.ok(!/[^\r]\n/.test(t), 'only CRLF line endings');
    assert.equal((await sb.run(['uninstall'])).code, 0);
    assert.equal(sb.read('.claude', 'settings.json'), '{\r\n  "model": "opus"\r\n}\r\n');
  } finally {
    sb.cleanup();
  }
});

test('duplicate or hand-edited talk-like-akane hook entries are a conflict, not silently rewritten', async () => {
  const sb = makeSandbox({ claude: true });
  try {
    assert.equal((await sb.run([])).code, 0);
    const s = sb.readJson('.claude', 'settings.json');
    s.hooks.SessionStart[0].hooks[0].timeout = 99;
    sb.write('.claude/settings.json', JSON.stringify(s, null, 2));
    const before = snapshot(sb.root);
    const r = await sb.run(['set-level', '3']);
    assert.equal(r.code, 3);
    assert.match(r.err, /edited after installation/);
    assert.deepEqual(snapshot(sb.root), before);
    s.hooks.SessionStart[0].hooks[0].timeout = 10;
    s.hooks.SessionStart.push(JSON.parse(JSON.stringify(s.hooks.SessionStart[0])));
    sb.write('.claude/settings.json', JSON.stringify(s, null, 2));
    const d = await sb.run([]);
    assert.equal(d.code, 3);
    assert.match(d.err, /2 talk-like-akane SessionStart entries/);
  } finally {
    sb.cleanup();
  }
});

test('POSIX hook command survives spaces and quotes in paths and runs through sh', { skip: IS_WIN }, async () => {
  const sb = makeSandbox({ claude: true, dataDirName: "data dir with 'quote' & space" });
  try {
    assert.equal((await sb.run([])).code, 0);
    const cmd = ourHookCommand(sb.readJson('.claude', 'settings.json').hooks.SessionStart, 'claude');
    assert.match(cmd, /^'.+node[^']*' '.+hook-runner\.mjs' --client claude --profile user --managed-by talk-like-akane$/);
    const r = runHookCommand(cmd, { hook_event_name: 'SessionStart', source: 'startup', session_id: 's' });
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).hookSpecificOutput.hookEventName, 'SessionStart');
  } finally {
    sb.cleanup();
  }
});

test('Windows hook command format: bare node, forward slashes, double quotes; unsafe characters refused', () => {
  const ctx = { platform: 'win32', env: {}, execPath: 'C:\\Program Files\\nodejs\\node.exe' };
  const cmd = buildHookCommand(ctx, 'C:\\Users\\Jane Doe\\AppData\\Local\\talk-like-akane\\runtime\\hook-runner.mjs', 'codex', 'user');
  assert.equal(cmd, 'node "C:/Users/Jane Doe/AppData/Local/talk-like-akane/runtime/hook-runner.mjs" --client codex --profile user --managed-by talk-like-akane');
  for (const bad of ['C:\\Users\\$me\\x.mjs', 'C:\\100%\\x.mjs', 'C:\\a"b\\x.mjs']) {
    assert.throws(() => buildHookCommand(ctx, bad, 'claude', 'user'), /unsafe in hook commands/);
  }
});

test('on Windows the registered command runs through cmd.exe and PowerShell from a path with spaces', { skip: !IS_WIN }, async () => {
  const sb = makeSandbox({ claude: true, codex: true, dataDirName: 'data dir with space' });
  try {
    assert.equal((await sb.run([])).code, 0);
    const cmd = ourHookCommand(sb.readJson('.codex', 'hooks.json').hooks.SessionStart, 'codex');
    const input = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' });
    const viaCmd = runHookCommand(cmd, input);
    assert.equal(viaCmd.code, 0, viaCmd.err);
    assert.ok(JSON.parse(viaCmd.out).hookSpecificOutput.additionalContext.includes('Akane'));
    const { spawnSync } = await import('node:child_process');
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], { input, encoding: 'utf8', env: process.env });
    if (!ps.error) {
      assert.equal(ps.status, 0, ps.stderr);
      assert.ok(JSON.parse(ps.stdout).hookSpecificOutput.additionalContext.includes('Akane'));
    }
    const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe'].find((p) => fs.existsSync(p));
    if (gitBash) {
      const b = spawnSync(gitBash, ['-c', cmd], { input, encoding: 'utf8', env: process.env });
      assert.equal(b.status, 0, b.stderr);
      assert.ok(JSON.parse(b.stdout).hookSpecificOutput.additionalContext.includes('Akane'));
    }
  } finally {
    sb.cleanup();
  }
});

test('the absolute node path in the POSIX command prefers a PATH-resolved node', () => {
  const sb = makeSandbox();
  try {
    if (IS_WIN) return;
    const fakeNode = path.join(sb.bin, 'node');
    fs.writeFileSync(fakeNode, '#!/bin/sh\n', { mode: 0o755 });
    const cmd = buildHookCommand({ platform: 'linux', env: { PATH: sb.bin }, execPath: '/versioned/node-22.1/bin/node' }, '/data/hook-runner.mjs', 'claude', 'user');
    assert.ok(cmd.startsWith(`'${fakeNode}' '/data/hook-runner.mjs'`));
    const fallback = buildHookCommand({ platform: 'linux', env: { PATH: '' }, execPath: '/versioned/node' }, '/data/hook-runner.mjs', 'claude', 'user');
    assert.ok(fallback.startsWith("'/versioned/node' "));
  } finally {
    sb.cleanup();
  }
});
