import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, runHookCommand, ourHookCommand, SOURCES, ROOT } from './helpers.mjs';
import { runOnce, shouldInject } from '../src/hook-runner.mjs';

function installAndGetCommands(sb) {
  const read = (rel, client) => (fs.existsSync(sb.p(...rel)) ? ourHookCommand(sb.readJson(...rel).hooks.SessionStart, client) : undefined);
  return { claude: read(['.claude', 'settings.json'], 'claude'), codex: read(['.codex', 'hooks.json'], 'codex') };
}

test('every session boundary (startup/resume/clear/compact/fork) injects one valid SessionStart context, with no skill call', async () => {
  const sb = makeSandbox({ claude: true, codex: true });
  try {
    assert.equal((await sb.run([])).code, 0);
    const cmds = installAndGetCommands(sb);
    for (const client of ['claude', 'codex']) {
      const groups = (client === 'claude' ? sb.readJson('.claude', 'settings.json') : sb.readJson('.codex', 'hooks.json')).hooks.SessionStart;
      assert.equal(groups.length, 1, 'registered exactly once');
      assert.equal(groups[0].hooks.length, 1);
      for (const source of SOURCES) {
        const input = { session_id: `s-${source}`, transcript_path: null, cwd: sb.project, hook_event_name: 'SessionStart', source, model: 'm' };
        const r = runHookCommand(cmds[client], input);
        assert.equal(r.code, 0, `${client}/${source}: ${r.err}`);
        assert.equal(r.err, '', 'no stderr noise');
        const lines = r.out.trim().split('\n');
        assert.equal(lines.length, 1, 'exactly one JSON payload');
        const payload = JSON.parse(lines[0]);
        assert.deepEqual(Object.keys(payload), ['hookSpecificOutput']);
        assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
        const ctx = payload.hookSpecificOutput.additionalContext;
        assert.match(ctx, /Akane/);
        assert.match(ctx, /teasing level 5\/5/);
        assert.match(ctx, /late 30s to early 40s/);
        assert.match(ctx, /stay neutral/);
        assert.match(ctx, /admit your own mistakes/);
        assert.match(ctx, client === 'claude' ? /the Akane output style/ : /block in AGENTS\.md/);
        const words = ctx.split(/\s+/).length;
        assert.ok(words > 60 && words < 230, `compact reminder, got ${words} words`);
      }
    }
  } finally {
    sb.cleanup();
  }
});

test('subagents, delegated workers and the env opt-out get no injection', async () => {
  const sb = makeSandbox({ claude: true });
  try {
    assert.equal((await sb.run([])).code, 0);
    const cmd = installAndGetCommands(sb).claude;
    const base = { hook_event_name: 'SessionStart', source: 'startup', cwd: sb.project };
    for (const extra of [{ agent_id: 'a1', agent_type: 'general-purpose' }, { agent_type: 'code-reviewer' }, { agent_type: 'Validator' }, { agent_type: 'feature-worker' }, { parent_session_id: 'p' }]) {
      const r = runHookCommand(cmd, { ...base, ...extra });
      assert.equal(r.code, 0);
      assert.equal(r.out, '', JSON.stringify(extra));
    }
    assert.equal(runHookCommand(cmd, base, { TALK_LIKE_AKANE_DISABLE: '1' }).out, '');
    // `claude --agent my-persona-agent` (main thread, no agent_id) is still the user-facing session.
    assert.match(runHookCommand(cmd, { ...base, agent_type: 'my-helper' }).out, /Akane/);
    assert.deepEqual(shouldInject({ hook_event_name: 'PreToolUse' }, {}), { inject: false, reason: 'not-session-start' });
  } finally {
    sb.cleanup();
  }
});

test('fail-open: missing profile, garbage stdin, empty stdin and bad args never block the session', async () => {
  const sb = makeSandbox({ codex: true });
  try {
    assert.equal((await sb.run([])).code, 0);
    const cmd = installAndGetCommands(sb).codex;
    assert.match(runHookCommand(cmd, 'not json at all').out, /Akane/, 'garbage stdin still injects');
    assert.match(runHookCommand(cmd, '').out, /Akane/, 'empty stdin still injects');
    const prof = path.join(sb.dataDir(), 'runtime', 'profiles', 'user.codex.json');
    fs.unlinkSync(prof);
    const r = runHookCommand(cmd, { hook_event_name: 'SessionStart', source: 'startup' });
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.equal(r.err, '');
    const marker = JSON.parse(fs.readFileSync(path.join(sb.dataDir(), 'runtime', 'markers', 'user.codex.json'), 'utf8'));
    assert.equal(marker.reason, 'profile-missing');
    assert.equal(runOnce({ argv: ['--client', 'vim'], stdinText: '{}', env: {} }).stdout, '');
    assert.equal(runOnce({ argv: ['--client', 'claude', '--profile', '../../etc'], stdinText: '{}', env: {} }).stdout, '');
  } finally {
    sb.cleanup();
  }
});

test('the hook runs from its persistent copy after the package source is gone', async () => {
  const sb = makeSandbox({ claude: true });
  const copy = path.join(sb.root, 'pkg-copy');
  try {
    // Simulate an npx cache: run the CLI from a throwaway copy of the package, then delete it.
    fs.cpSync(ROOT, copy, { recursive: true, filter: (s) => !/node_modules|\.git$|[\\/]tests[\\/]?/.test(path.relative(ROOT, s)) || s === ROOT });
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [path.join(copy, 'bin', 'talk-like-akane.mjs')], { cwd: sb.project, env: sb.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    fs.rmSync(copy, { recursive: true, force: true });
    const cmd = installAndGetCommands(sb).claude;
    assert.ok(!cmd.includes(copy), 'hook does not point into the package copy');
    assert.ok(cmd.includes(sb.dataDir()) || cmd.includes(sb.dataDir().replace(/\\/g, '/')), 'hook points into the per-user data dir');
    const out = runHookCommand(cmd, { hook_event_name: 'SessionStart', source: 'resume' });
    assert.equal(out.code, 0, out.err);
    assert.match(JSON.parse(out.out).hookSpecificOutput.additionalContext, /Akane/);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
    sb.cleanup();
  }
});

test('the hook runner is self-contained: Node built-ins only, with no network, child processes or model calls', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'hook-runner.mjs'), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const i of imports) assert.match(i, /^node:(fs|path|url)$/, `unexpected import ${i}`);
  assert.ok(!/fetch\(|node:https?|node:net|child_process|XMLHttpRequest|WebSocket/.test(src));
});

test('status distinguishes REGISTERED, VERIFIED (after a real run) and Codex TRUST_PENDING / UNKNOWN / OVERRIDDEN', async () => {
  const sb = makeSandbox({ claude: true, codex: true });
  try {
    sb.write('.codex/config.toml', 'model = "x"\n');
    assert.equal((await sb.run([])).code, 0);
    let st = JSON.parse((await sb.run(['status', '--json'])).out).installs[0].targets;
    assert.equal(st.claude.hook.state, 'REGISTERED');
    assert.equal(st.codex.hook.state, 'TRUST_PENDING');
    assert.equal(st.codex.agents.state, 'ACTIVE', 'AGENTS.md carries the persona while the hook waits for trust');

    const hooksPath = sb.p('.codex', 'hooks.json');
    sb.write('.codex/config.toml', `model = "x"\n\n[hooks.state]\n\n[hooks.state.${JSON.stringify(`${hooksPath}:session_start:0:0`)}]\ntrusted_hash = "sha256:abc"\n`);
    st = JSON.parse((await sb.run(['status', '--json'])).out).installs[0].targets;
    assert.equal(st.codex.hook.state, 'UNKNOWN', 'a trust record whose hash we cannot verify is not reported as verified');

    sb.write('.codex/config.toml', `[hooks.state.${JSON.stringify(`${hooksPath}:session_start:0:0`)}]\ntrusted_hash = "sha256:abc"\nenabled = false\n`);
    st = JSON.parse((await sb.run(['status', '--json'])).out).installs[0].targets;
    assert.equal(st.codex.hook.state, 'OVERRIDDEN');

    sb.write('.codex/config.toml', '');
    const cmds = installAndGetCommands(sb);
    runHookCommand(cmds.claude, { hook_event_name: 'SessionStart', source: 'startup' });
    runHookCommand(cmds.codex, { hook_event_name: 'SessionStart', source: 'compact' });
    st = JSON.parse((await sb.run(['status', '--json'])).out).installs[0].targets;
    assert.equal(st.claude.hook.state, 'VERIFIED');
    assert.match(st.claude.hook.detail, /source: startup/);
    assert.equal(st.codex.hook.state, 'VERIFIED');

    sb.write('.codex/config.toml', '[features]\nhooks = false\n');
    st = JSON.parse((await sb.run(['status', '--json'])).out).installs[0].targets;
    assert.equal(st.codex.hook.state, 'OVERRIDDEN');
  } finally {
    sb.cleanup();
  }
});

test('a user-scope hook steps aside inside a project that has its own project-scope install', async () => {
  const sb = makeSandbox({ claude: true });
  try {
    assert.equal((await sb.run([])).code, 0);
    assert.equal((await sb.run(['install', '--scope', 'project', '--level', '2'])).code, 0);
    const userCmd = ourHookCommand(sb.readJson('.claude', 'settings.json').hooks.SessionStart, 'claude');
    const projCmd = ourHookCommand(JSON.parse(fs.readFileSync(path.join(sb.project, '.claude', 'settings.local.json'), 'utf8')).hooks.SessionStart, 'claude');
    const inProject = { hook_event_name: 'SessionStart', source: 'startup', cwd: path.join(sb.project) };
    assert.equal(runHookCommand(userCmd, inProject).out, '', 'user hook skipped in the project');
    assert.match(runHookCommand(projCmd, inProject).out, /teasing level 2\/5/);
    assert.match(runHookCommand(userCmd, { ...inProject, cwd: sb.root }).out, /teasing level 5\/5/, 'user hook active elsewhere');
  } finally {
    sb.cleanup();
  }
});
