import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, snapshot, IS_WIN } from './helpers.mjs';
import { Plan, applyPlan } from '../src/tx.mjs';

function seed(sb) {
  sb.write('.claude/settings.json', '{\n  "model": "opus",\n  "outputStyle": "Concise"\n}\n');
  sb.write('.codex/AGENTS.md', '# global rules\n');
  sb.write('.codex/hooks.json', '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"true"}]}]}}');
}

test('a failure at any point of a two-client install rolls back every change from that run', async () => {
  // Count the operations of a clean install first, then fail after 0..n-1 of them.
  const probe = makeSandbox({ claude: true, codex: true });
  seed(probe);
  const n = (await probe.run(['install', '--dry-run', '--json'])).out;
  const total = JSON.parse(n).plan.length;
  probe.cleanup();
  assert.ok(total >= 10, `expected many operations, got ${total}`);
  for (const k of [0, 1, Math.floor(total / 2), total - 1]) {
    const sb = makeSandbox({ claude: true, codex: true });
    try {
      seed(sb);
      const before = snapshot(sb.root);
      const r = await sb.run([], { faultAfterOps: k });
      assert.equal(r.code, 4, `fault after ${k}: ${r.err}`);
      assert.match(r.err, /rolled back/);
      assert.deepEqual(snapshot(sb.root), before, `fault after ${k} op(s) left changes behind`);
    } finally {
      sb.cleanup();
    }
  }
});

test('a failure during uninstall rolls back too', async () => {
  const sb = makeSandbox({ claude: true, codex: true });
  try {
    seed(sb);
    assert.equal((await sb.run([])).code, 0);
    const before = snapshot(sb.home);
    const r = await sb.run(['uninstall'], { faultAfterOps: 3 });
    assert.equal(r.code, 4);
    assert.deepEqual(snapshot(sb.home), before);
    assert.equal((await sb.run(['uninstall'])).code, 0);
  } finally {
    sb.cleanup();
  }
});

test('a real permission error on the Codex side rolls back the Claude side', { skip: IS_WIN || process.getuid?.() === 0 }, async () => {
  const sb = makeSandbox({ claude: true, codex: true });
  try {
    seed(sb);
    fs.mkdirSync(sb.p('.agents', 'skills'), { recursive: true });
    fs.chmodSync(sb.p('.agents', 'skills'), 0o500);
    const before = snapshot(sb.root);
    const r = await sb.run([]);
    assert.equal(r.code, 4, r.err);
    assert.match(r.err, /EACCES|permission/i);
    fs.chmodSync(sb.p('.agents', 'skills'), 0o755);
    assert.deepEqual(snapshot(sb.root), before);
  } finally {
    try {
      fs.chmodSync(sb.p('.agents', 'skills'), 0o755);
    } catch {
      /* ignore */
    }
    sb.cleanup();
  }
});

test('invalid JSON in settings.json or hooks.json aborts before any change', async () => {
  for (const [rel, bad] of [
    ['.claude/settings.json', '{"model": "opus",,}'],
    ['.codex/hooks.json', '{"hooks": ['],
    ['.claude/settings.json', '[1,2,3]'],
    ['.claude/settings.json', '{"hooks": []}'],
    ['.codex/hooks.json', '{"hooks": {"SessionStart": {}}}'],
  ]) {
    const sb = makeSandbox({ claude: true, codex: true });
    try {
      sb.write(rel, bad);
      const before = snapshot(sb.root);
      const r = await sb.run([]);
      assert.equal(r.code, 3, `${rel} ${bad}: ${r.err}`);
      assert.match(r.err, /Nothing was changed/);
      assert.deepEqual(snapshot(sb.root), before);
    } finally {
      sb.cleanup();
    }
  }
});

test('damaged or duplicate AGENTS markers abort safely', async () => {
  for (const content of ['x\n<!-- talk-like-akane:start -->\nno end\n', '<!-- talk-like-akane:end -->\n<!-- talk-like-akane:start -->\n', '<!-- talk-like-akane:start -->\na\n<!-- talk-like-akane:end -->\n<!-- talk-like-akane:start -->\nb\n<!-- talk-like-akane:end -->\n']) {
    const sb = makeSandbox({ codex: true });
    try {
      sb.write('.codex/AGENTS.md', content);
      const before = snapshot(sb.root);
      const r = await sb.run([]);
      assert.equal(r.code, 3);
      assert.match(r.err, /damaged or duplicate|did not record/);
      assert.deepEqual(snapshot(sb.root), before);
    } finally {
      sb.cleanup();
    }
  }
});

test('hand edits inside the managed AGENTS block are reported, never silently removed', async () => {
  const sb = makeSandbox({ codex: true });
  try {
    sb.write('.codex/AGENTS.md', '# mine\n');
    assert.equal((await sb.run([])).code, 0);
    const f = sb.p('.codex', 'AGENTS.md');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('### Hard boundaries', '### Hard boundaries\n- my own rule'));
    const before = snapshot(sb.root);
    const up = await sb.run(['set-level', '2']);
    assert.equal(up.code, 3);
    assert.match(up.err, /edited by hand/);
    const un = await sb.run(['uninstall']);
    assert.equal(un.code, 3);
    assert.match(un.err, /will not be removed silently/);
    assert.deepEqual(snapshot(sb.root), before);
    const st = await sb.run(['status']);
    assert.equal(st.code, 3);
    assert.match(st.out, /AGENTS block\s+MODIFIED/);
  } finally {
    sb.cleanup();
  }
});

test('symlinked config files keep their link; dangling links and symlinked managed files abort', { skip: IS_WIN }, async () => {
  const sb = makeSandbox({ claude: true });
  try {
    const real = path.join(sb.root, 'dotfiles', 'claude-settings.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '{"model":"opus"}\n');
    fs.mkdirSync(sb.p('.claude'), { recursive: true });
    fs.symlinkSync(real, sb.p('.claude', 'settings.json'));
    const r = await sb.run([]);
    assert.equal(r.code, 0, r.err);
    assert.ok(fs.lstatSync(sb.p('.claude', 'settings.json')).isSymbolicLink(), 'link preserved');
    assert.equal(JSON.parse(fs.readFileSync(real, 'utf8')).outputStyle, 'Akane');
    assert.equal((await sb.run(['uninstall'])).code, 0);
    assert.ok(fs.lstatSync(sb.p('.claude', 'settings.json')).isSymbolicLink());
    assert.equal(fs.readFileSync(real, 'utf8'), '{"model":"opus"}\n');
  } finally {
    sb.cleanup();
  }

  const dangling = makeSandbox({ claude: true });
  try {
    fs.mkdirSync(dangling.p('.claude'), { recursive: true });
    fs.symlinkSync(path.join(dangling.root, 'nowhere.json'), dangling.p('.claude', 'settings.json'));
    const before = snapshot(dangling.root);
    const r = await dangling.run([]);
    assert.equal(r.code, 3);
    assert.match(r.err, /broken symlink/);
    assert.deepEqual(snapshot(dangling.root), before);
  } finally {
    dangling.cleanup();
  }

  const linkedStyle = makeSandbox({ claude: true });
  try {
    const target = path.join(linkedStyle.root, 'elsewhere.md');
    fs.writeFileSync(target, 'not ours\n');
    fs.mkdirSync(linkedStyle.p('.claude', 'output-styles'), { recursive: true });
    fs.symlinkSync(target, linkedStyle.p('.claude', 'output-styles', 'akane.md'));
    const before = snapshot(linkedStyle.root);
    const r = await linkedStyle.run([]);
    assert.equal(r.code, 3);
    assert.deepEqual(snapshot(linkedStyle.root), before);
    assert.equal(fs.readFileSync(target, 'utf8'), 'not ours\n');
  } finally {
    linkedStyle.cleanup();
  }
});

test('concurrent modification between planning and applying aborts with no changes', () => {
  const sb = makeSandbox();
  try {
    const f = sb.write('a.txt', 'one');
    const g = path.join(sb.home, 'b.txt');
    const plan = new Plan();
    plan.put(g, null, 'new file');
    plan.put(f, Buffer.from('one'), 'two');
    fs.writeFileSync(f, 'someone else'); // edited after planning
    assert.throws(() => applyPlan(plan), /changed while talk-like-akane was running/);
    assert.equal(fs.readFileSync(f, 'utf8'), 'someone else');
    assert.ok(!fs.existsSync(g));
  } finally {
    sb.cleanup();
  }
});

test('a held lock blocks a second mutating run; status still works', async () => {
  const sb = makeSandbox({ claude: true });
  try {
    fs.mkdirSync(sb.dataDir(), { recursive: true });
    fs.writeFileSync(path.join(sb.dataDir(), '.lock'), '{}');
    const r = await sb.run([]);
    assert.equal(r.code, 3);
    assert.match(r.err, /Another talk-like-akane process/);
    assert.equal((await sb.run(['status'])).code, 2);
  } finally {
    sb.cleanup();
  }
});

test('a corrupted state file is reported and nothing is modified', async () => {
  const sb = makeSandbox({ claude: true });
  try {
    assert.equal((await sb.run([])).code, 0);
    fs.writeFileSync(path.join(sb.dataDir(), 'state.json'), '{nope');
    const before = snapshot(sb.root);
    for (const argv of [[], ['uninstall'], ['set-level', '2']]) {
      const r = await sb.run(argv);
      assert.equal(r.code, 3, argv.join(' '));
    }
    assert.equal((await sb.run(['status'])).code, 3);
    assert.deepEqual(snapshot(sb.root), before);
  } finally {
    sb.cleanup();
  }
});
