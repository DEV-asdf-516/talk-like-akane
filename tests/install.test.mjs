import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, snapshot } from './helpers.mjs';

const STYLE = ['.claude', 'output-styles', 'akane.md'];
const CLAUDE_SKILL = ['.claude', 'skills', 'talk-like-akane', 'SKILL.md'];
const CODEX_SKILL = ['.agents', 'skills', 'talk-like-akane', 'SKILL.md'];

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'frontmatter present');
  return Object.fromEntries(m[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
}

test('no-argument run installs for every detected client with user scope, level 5, language auto', async () => {
  const sb = makeSandbox({ claude: true, codex: true });
  try {
    const r = await sb.run([]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /level 5\/5/);
    assert.match(r.out, /language auto/);
    assert.equal(sb.readJson('.claude', 'settings.json').outputStyle, 'Akane');
    assert.ok(fs.existsSync(sb.p(...STYLE)));
    assert.ok(fs.existsSync(sb.p(...CLAUDE_SKILL)));
    assert.ok(fs.existsSync(sb.p(...CODEX_SKILL)));
    assert.match(sb.read('.codex', 'AGENTS.md'), /<!-- talk-like-akane:start -->[\s\S]*<!-- talk-like-akane:end -->/);
    assert.equal(sb.readJson('.codex', 'hooks.json').hooks.SessionStart.length, 1);
    const st = sb.state();
    assert.equal(st.installs.user.level, 5);
    assert.equal(st.installs.user.language, 'auto');
    assert.deepEqual(Object.keys(st.installs.user.targets).sort(), ['claude', 'codex']);
    assert.ok(!/token|secret|password/i.test(JSON.stringify(st)), 'state holds no secrets');
    assert.match(r.out, /Akane answers from the first message, with no slash command/);
  } finally {
    sb.cleanup();
  }
});

test('the bin entry itself (spawned process) installs with no arguments', () => {
  const sb = makeSandbox({ claude: true });
  try {
    const r = sb.spawn([]);
    assert.equal(r.code, 0, r.err);
    assert.equal(sb.readJson('.claude', 'settings.json').outputStyle, 'Akane');
  } finally {
    sb.cleanup();
  }
});

test('auto-detection: Claude only, Codex only (config dir only), both', async () => {
  const a = makeSandbox({ claude: true });
  const b = makeSandbox({ codexDir: true });
  const c = makeSandbox({ claudeDir: true, codex: true });
  try {
    assert.equal((await a.run([])).code, 0);
    assert.deepEqual(Object.keys(a.state().installs.user.targets), ['claude']);
    assert.ok(!fs.existsSync(a.p('.codex')) && !fs.existsSync(a.p('.agents')), 'Codex untouched');
    assert.equal((await b.run([])).code, 0);
    assert.deepEqual(Object.keys(b.state().installs.user.targets), ['codex']);
    assert.ok(!fs.existsSync(b.p('.claude')), 'Claude untouched');
    assert.equal((await c.run([])).code, 0);
    assert.deepEqual(Object.keys(c.state().installs.user.targets).sort(), ['claude', 'codex']);
  } finally {
    a.cleanup();
    b.cleanup();
    c.cleanup();
  }
});

test('no client detected: exit 2, explains --target, and creates nothing (not even state)', async () => {
  const sb = makeSandbox();
  try {
    const before = snapshot(sb.root);
    const r = await sb.run([]);
    assert.equal(r.code, 2);
    assert.match(r.err, /No supported client detected/);
    assert.match(r.err, /--target claude/);
    assert.deepEqual(snapshot(sb.root), before);
    assert.equal(sb.state(), null);
  } finally {
    sb.cleanup();
  }
});

test('explicit --target installs only that client, even when not detected (with a warning)', async () => {
  const sb = makeSandbox({ claude: true });
  try {
    const r = await sb.run(['install', '--target', 'codex']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Codex was not detected; installed anyway/);
    assert.ok(!fs.existsSync(sb.p('.claude')));
    assert.deepEqual(Object.keys(sb.state().installs.user.targets), ['codex']);
    const both = await sb.run(['install', '--target', 'both']);
    assert.equal(both.code, 0, both.err);
    assert.deepEqual(Object.keys(sb.state().installs.user.targets).sort(), ['claude', 'codex']);
  } finally {
    sb.cleanup();
  }
});

test('invalid arguments fail with exit 1 and change nothing', async () => {
  const sb = makeSandbox({ claude: true, codex: true });
  try {
    const before = snapshot(sb.root);
    for (const argv of [
      ['install', '--target', 'vim'],
      ['install', '--scope', 'global'],
      ['install', '--level', '9'],
      ['install', '--level', '2.5'],
      ['install', '--level'],
      ['install', '--project-root', sb.project],
      ['install', '--wat'],
      ['frobnicate'],
      ['set-level'],
      ['set-level', '0'],
      ['set-language', 'not a tag!'],
      ['status', '--dry-run'],
      ['install', '--scope', 'project', '--project-root', path.join(sb.root, 'missing')],
      ['install', '--scope', 'project', '--project-root', sb.home],
    ]) {
      const r = await sb.run(argv);
      assert.equal(r.code, 1, `${argv.join(' ')} -> ${r.code} ${r.out}${r.err}`);
    }
    assert.deepEqual(snapshot(sb.root), before);
  } finally {
    sb.cleanup();
  }
});

test('Claude output style has name Akane and keep-coding-instructions: true; skills have valid frontmatter', async () => {
  const sb = makeSandbox({ claude: true, codex: true });
  try {
    assert.equal((await sb.run([])).code, 0);
    const fm = frontmatter(sb.read(...STYLE));
    assert.equal(fm.name, 'Akane');
    assert.equal(fm['keep-coding-instructions'], 'true');
    assert.ok(fm.description.length > 10);
    assert.ok(!('force-for-plugin' in fm), 'never forces over plugins');
    for (const skill of [CLAUDE_SKILL, CODEX_SKILL]) {
      const sfm = frontmatter(sb.read(...skill));
      assert.equal(sfm.name, 'talk-like-akane');
      assert.ok(sfm.description.length > 20 && sfm.description.length < 1024);
      assert.match(sfm.description, /only when the user explicitly asks/i);
      assert.ok(!/every coding task|모든 코딩 작업/i.test(sfm.description));
    }
    assert.match(sb.read(...CLAUDE_SKILL), /output style/);
    assert.match(sb.read(...CODEX_SKILL), /AGENTS\.md/);
  } finally {
    sb.cleanup();
  }
});

test('Claude settings: unrelated keys are preserved and the previous outputStyle is restored on uninstall', async () => {
  const sb = makeSandbox({ claude: true });
  try {
    const original = '{\n    "model": "opus",\n    "outputStyle": "Explanatory",\n    "permissions": { "allow": ["Bash(ls:*)"] },\n    "env": { "FOO": "1" }\n}\n';
    sb.write('.claude/settings.json', original);
    assert.equal((await sb.run([])).code, 0);
    const s = sb.readJson('.claude', 'settings.json');
    assert.equal(s.outputStyle, 'Akane');
    assert.equal(s.model, 'opus');
    assert.deepEqual(s.permissions, { allow: ['Bash(ls:*)'] });
    assert.deepEqual(s.env, { FOO: '1' });
    assert.match(sb.read('.claude', 'settings.json'), /^ {4}"model"/m, '4-space indentation kept');
    assert.deepEqual(sb.state().installs.user.targets.claude.settings.prevOutputStyle, { present: true, value: 'Explanatory' });
    assert.equal((await sb.run(['uninstall'])).code, 0);
    assert.equal(sb.read('.claude', 'settings.json'), original, 'byte-identical restore');
  } finally {
    sb.cleanup();
  }
});

test('uninstall keeps an outputStyle the user picked after installing', async () => {
  const sb = makeSandbox({ claude: true });
  try {
    sb.write('.claude/settings.json', '{"outputStyle":"Explanatory"}\n');
    assert.equal((await sb.run([])).code, 0);
    const s = sb.readJson('.claude', 'settings.json');
    s.outputStyle = 'Learning';
    sb.write('.claude/settings.json', JSON.stringify(s, null, 2) + '\n');
    const r = await sb.run(['uninstall']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /kept outputStyle "Learning"/);
    const after = sb.readJson('.claude', 'settings.json');
    assert.equal(after.outputStyle, 'Learning');
    assert.equal(after.hooks, undefined);
    assert.ok(!fs.existsSync(sb.p(...STYLE)));
  } finally {
    sb.cleanup();
  }
});

test('re-install is idempotent; set-level and update are applied without duplicates', async () => {
  const sb = makeSandbox({ claude: true, codex: true });
  try {
    sb.write('.codex/AGENTS.md', '# Team rules\n\nUse pnpm.\n');
    assert.equal((await sb.run([])).code, 0);
    const snap1 = snapshot(sb.home);
    const again = await sb.run([]);
    assert.equal(again.code, 0);
    assert.match(again.out, /Already up to date/);
    assert.deepEqual(snapshot(sb.home), snap1, 'second run writes nothing');

    assert.equal((await sb.run(['set-level', '3'])).code, 0);
    assert.match(sb.read(...STYLE), /current level 3\/5/);
    assert.match(sb.read(...STYLE), /- 3: [^\n]*\(current default\)/);
    assert.match(sb.read('.codex', 'AGENTS.md'), /current level 3\/5/);
    assert.equal(sb.state().installs.user.level, 3);
    const prof = JSON.parse(fs.readFileSync(path.join(sb.dataDir(), 'runtime', 'profiles', 'user.claude.json'), 'utf8'));
    assert.equal(prof.level, 3);
    assert.match(prof.context, /teasing level 3\/5/);

    // A plain re-run keeps the saved level (it does not reset to the default).
    assert.equal((await sb.run([])).code, 0);
    assert.equal(sb.state().installs.user.level, 3);
    const up = await sb.run(['update']);
    assert.equal(up.code, 0);
    assert.match(up.out, /Already up to date/);

    const agents = sb.read('.codex', 'AGENTS.md');
    assert.equal(agents.split('<!-- talk-like-akane:start -->').length - 1, 1);
    assert.ok(agents.startsWith('# Team rules\n\nUse pnpm.\n'));
    assert.equal(sb.readJson('.claude', 'settings.json').hooks.SessionStart.length, 1);
    assert.equal(sb.readJson('.codex', 'hooks.json').hooks.SessionStart.length, 1);

    assert.equal((await sb.run(['set-level', '5'])).code, 0);
    const noState = (snap) => Object.fromEntries(Object.entries(snap).filter(([k]) => !k.endsWith('state.json')));
    assert.deepEqual(noState(snapshot(sb.home)), noState(snap1), 'back to the default level = identical files (state only records timestamps)');
  } finally {
    sb.cleanup();
  }
});

test('uninstall restores every file byte-for-byte and removes everything it created', async () => {
  const sb = makeSandbox({ claude: true, codex: true });
  try {
    sb.write('.claude/settings.json', '{"model":"sonnet"}');
    sb.write('.codex/AGENTS.md', '# keep me\r\nline two'); // CRLF, no trailing newline
    sb.write('.codex/config.toml', 'model = "gpt"\n');
    const before = snapshot(sb.home);
    assert.equal((await sb.run([])).code, 0);
    assert.match(sb.read('.codex', 'AGENTS.md'), /^# keep me\r\nline two\r\n\r\n<!-- talk-like-akane:start -->\r\n/);
    assert.equal(sb.read('.codex', 'config.toml'), 'model = "gpt"\n', 'config.toml never modified');
    const r = await sb.run(['uninstall']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(snapshot(sb.home), before);
    assert.ok(!fs.existsSync(sb.dataDir()), 'data dir removed');
    assert.equal((await sb.run(['uninstall'])).code, 2, 'second uninstall: nothing installed');
  } finally {
    sb.cleanup();
  }
});

test('uninstall of one target keeps the other', async () => {
  const sb = makeSandbox({ claude: true, codex: true });
  try {
    assert.equal((await sb.run([])).code, 0);
    assert.equal((await sb.run(['uninstall', '--target', 'claude'])).code, 0);
    assert.ok(!fs.existsSync(sb.p(...STYLE)));
    assert.ok(fs.existsSync(sb.p(...CODEX_SKILL)));
    assert.deepEqual(Object.keys(sb.state().installs.user.targets), ['codex']);
    assert.ok(fs.existsSync(path.join(sb.dataDir(), 'runtime', 'hook-runner.mjs')));
    assert.equal((await sb.run(['uninstall', '--target', 'claude'])).code, 2);
  } finally {
    sb.cleanup();
  }
});

test('existing foreign akane.md or talk-like-akane skill is never overwritten', async () => {
  for (const rel of ['.claude/output-styles/akane.md', '.claude/skills/talk-like-akane/SKILL.md', '.agents/skills/talk-like-akane/SKILL.md']) {
    const sb = makeSandbox({ claude: true, codex: true });
    try {
      sb.write(rel, 'someone else wrote this\n');
      const before = snapshot(sb.root);
      const r = await sb.run([]);
      assert.equal(r.code, 3, `${rel}: ${r.out}${r.err}`);
      assert.match(r.err, /not created by talk-like-akane|already exists/);
      assert.deepEqual(snapshot(sb.root), before, `${rel}: nothing changed`);
    } finally {
      sb.cleanup();
    }
  }
});

test('a managed file edited by the user blocks update and uninstall instead of being clobbered', async () => {
  const sb = makeSandbox({ claude: true });
  try {
    assert.equal((await sb.run([])).code, 0);
    fs.appendFileSync(sb.p(...STYLE), '\nmy tweak\n');
    const before = snapshot(sb.root);
    const up = await sb.run(['set-level', '2']);
    assert.equal(up.code, 3);
    assert.match(up.err, /modified after talk-like-akane installed it/);
    const un = await sb.run(['uninstall']);
    assert.equal(un.code, 3);
    assert.deepEqual(snapshot(sb.root), before);
  } finally {
    sb.cleanup();
  }
});

test('status, --dry-run, --help and --version never write anything', async () => {
  const sb = makeSandbox({ claude: true, codex: true });
  try {
    let before = snapshot(sb.root);
    for (const argv of [['status'], ['status', '--json'], ['--dry-run'], ['install', '--dry-run', '--json'], ['--help'], ['--version'], ['help']]) {
      const r = await sb.run(argv);
      assert.ok([0, 2].includes(r.code), `${argv}: ${r.code} ${r.err}`);
      assert.deepEqual(snapshot(sb.root), before, `${argv.join(' ')} wrote files`);
    }
    const dry = await sb.run(['install', '--dry-run']);
    assert.match(dry.out, /create .*akane\.md/);
    assert.match(dry.out, /Dry run: nothing was written/);
    assert.equal((await sb.run([])).code, 0);
    before = snapshot(sb.root);
    for (const argv of [['status'], ['uninstall', '--dry-run'], ['set-level', '1', '--dry-run'], ['set-language', 'ja', '--dry-run'], ['update', '--dry-run']]) {
      const r = await sb.run(argv);
      assert.equal(r.code, 0, `${argv}: ${r.err}`);
      assert.deepEqual(snapshot(sb.root), before, `${argv.join(' ')} wrote files`);
    }
    const v = await sb.run(['--version']);
    assert.match(v.out, /^\d+\.\d+\.\d+\n$/);
    const st = JSON.parse((await sb.run(['status', '--json'])).out);
    assert.equal(st.installs[0].targets.claude.outputStyle.state, 'ACTIVE');
  } finally {
    sb.cleanup();
  }
});

test('default (user scope) install never modifies the current project', async () => {
  const sb = makeSandbox({ claude: true, codex: true });
  try {
    fs.writeFileSync(path.join(sb.project, 'AGENTS.md'), '# project rules\n');
    fs.mkdirSync(path.join(sb.project, '.claude'));
    fs.writeFileSync(path.join(sb.project, '.claude', 'settings.json'), '{"x":1}\n');
    const before = snapshot(sb.project);
    assert.equal((await sb.run([])).code, 0);
    assert.equal((await sb.run(['set-level', '3'])).code, 0);
    assert.equal((await sb.run(['uninstall'])).code, 0);
    assert.deepEqual(snapshot(sb.project), before);
  } finally {
    sb.cleanup();
  }
});

test('project scope installs inside the repository only and uninstalls cleanly', async () => {
  const sb = makeSandbox({ claude: true, codex: true });
  try {
    const homeBefore = snapshot(sb.home);
    const projBefore = snapshot(sb.project);
    const r = await sb.run(['install', '--scope', 'project'], { cwd: path.join(sb.project) });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /do not commit them/);
    const P = (...x) => path.join(sb.project, ...x);
    assert.equal(JSON.parse(fs.readFileSync(P('.claude', 'settings.local.json'), 'utf8')).outputStyle, 'Akane');
    assert.ok(fs.existsSync(P('.claude', 'output-styles', 'akane.md')));
    assert.ok(fs.existsSync(P('.claude', 'skills', 'talk-like-akane', 'SKILL.md')));
    assert.ok(fs.existsSync(P('.agents', 'skills', 'talk-like-akane', 'SKILL.md')));
    assert.match(fs.readFileSync(P('AGENTS.md'), 'utf8'), /talk-like-akane:start/);
    assert.equal(JSON.parse(fs.readFileSync(P('.codex', 'hooks.json'), 'utf8')).hooks.SessionStart.length, 1);
    // Home is untouched apart from the tool's own data directory.
    const dataRel = path.relative(sb.home, sb.dataDir());
    for (const k of Object.keys(snapshot(sb.home)).filter((x) => !(x in homeBefore))) {
      assert.ok(k === dataRel || k.startsWith(dataRel + path.sep) || dataRel.startsWith(k + path.sep), `unexpected change in home: ${k}`);
    }
    const st = await sb.run(['status', '--project-root', sb.project]);
    assert.match(st.out, /\[project /);
    const un = await sb.run(['uninstall', '--scope', 'project', '--project-root', sb.project]);
    assert.equal(un.code, 0, un.err);
    assert.deepEqual(snapshot(sb.project), projBefore);
  } finally {
    sb.cleanup();
  }
});

test('maintenance commands require an existing install (exit 2)', async () => {
  const sb = makeSandbox({ claude: true });
  try {
    for (const argv of [['update'], ['set-level', '3'], ['set-language', 'en'], ['uninstall']]) {
      const r = await sb.run(argv);
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.err, /not installed/);
    }
  } finally {
    sb.cleanup();
  }
});
