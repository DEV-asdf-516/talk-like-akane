import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox } from './helpers.mjs';
import { parseTomlLite, findTrustEntry } from '../src/status.mjs';

async function statusOf(sb, extra) {
  const r = await sb.run(['status', '--json'], extra);
  return { code: r.code, report: JSON.parse(r.out) };
}

test('Claude: a project outputStyle overrides the global Akane style and status says so (exit 3)', async () => {
  const sb = makeSandbox({ claude: true });
  try {
    assert.equal((await sb.run([])).code, 0);
    assert.equal((await statusOf(sb)).report.installs[0].targets.claude.outputStyle.state, 'ACTIVE');
    fs.mkdirSync(path.join(sb.project, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(sb.project, '.claude', 'settings.local.json'), '{"outputStyle":"Explanatory"}');
    const { code, report } = await statusOf(sb);
    assert.equal(code, 3);
    const os = report.installs[0].targets.claude.outputStyle;
    assert.equal(os.state, 'OVERRIDDEN');
    assert.match(os.detail, /project local setting .*settings\.local\.json selects "Explanatory"/);
    // The install output reports the same and does not claim it is active.
    const re = await sb.run([]);
    assert.match(re.out, /outputStyle\s+OVERRIDDEN/);
    // Somewhere else, the global style still applies.
    const elsewhere = await statusOf(sb, { cwd: sb.root });
    assert.equal(elsewhere.report.installs[0].targets.claude.outputStyle.state, 'ACTIVE');
  } finally {
    sb.cleanup();
  }
});

test('Claude: managed policy, disableAllHooks, forced plugin styles and a shadowing project style are diagnosed', async () => {
  const sb = makeSandbox({ claude: true });
  try {
    assert.equal((await sb.run([])).code, 0);
    sb.write(sb.managedSettingsPaths[0], '{"outputStyle":"Concise","disableAllHooks":true}');
    let t = (await statusOf(sb)).report.installs[0].targets.claude;
    assert.equal(t.outputStyle.state, 'OVERRIDDEN');
    assert.match(t.outputStyle.detail, /managed policy/);
    assert.equal(t.hook.state, 'OVERRIDDEN');
    fs.rmSync(path.dirname(sb.managedSettingsPaths[0]), { recursive: true });

    sb.write('.claude/plugins/cache/acme/1.0/output-styles/loud.md', '---\nname: Loud\nforce-for-plugin: true\n---\nShout.\n');
    sb.write(path.join(sb.project, '.claude', 'output-styles', 'mine.md'), '---\nname: Akane\n---\nlocal copy\n');
    t = (await statusOf(sb)).report.installs[0].targets.claude;
    assert.ok(t.warnings.some((w) => /force-for-plugin: true .*NEEDS_VERIFICATION/.test(w)));
    assert.ok(t.warnings.some((w) => /also named "Akane" and takes precedence/.test(w)));
    const env = (await statusOf(sb, { env: { CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: '1' } })).report.installs[0].targets.claude;
    assert.ok(env.warnings.some((w) => /keep-coding-instructions only takes effect with the full system prompt/.test(w)));
  } finally {
    sb.cleanup();
  }
});

test('running status from the home directory does not mistake the user files for project overrides', async () => {
  const sb = makeSandbox({ claude: true });
  try {
    assert.equal((await sb.run([], { cwd: sb.home })).code, 0);
    const { code, report } = await statusOf(sb, { cwd: sb.home });
    const t = report.installs[0].targets.claude;
    assert.equal(code, 0);
    assert.equal(t.outputStyle.state, 'ACTIVE');
    assert.deepEqual(t.warnings, []);
  } finally {
    sb.cleanup();
  }
});

test('Codex: a non-empty AGENTS.override.md is the effective file, so the block goes there and AGENTS.md is untouched', async () => {
  const sb = makeSandbox({ codex: true });
  try {
    sb.write('.codex/AGENTS.md', '# ignored by Codex while the override exists\n');
    sb.write('.codex/AGENTS.override.md', '# override rules\n');
    assert.equal((await sb.run([])).code, 0);
    assert.equal(sb.read('.codex', 'AGENTS.md'), '# ignored by Codex while the override exists\n');
    assert.match(sb.read('.codex', 'AGENTS.override.md'), /^# override rules\n\n<!-- talk-like-akane:start -->/);
    const t = (await statusOf(sb)).report.installs[0].targets.codex;
    assert.equal(t.agents.state, 'ACTIVE');
    assert.match(t.agents.detail, /AGENTS\.override\.md/);
    assert.equal((await sb.run(['uninstall'])).code, 0);
    assert.equal(sb.read('.codex', 'AGENTS.override.md'), '# override rules\n');
  } finally {
    sb.cleanup();
  }
});

test('Codex: an empty override is skipped; an override created later is reported and update moves the block', async () => {
  const sb = makeSandbox({ codex: true });
  try {
    sb.write('.codex/AGENTS.override.md', '   \n');
    sb.write('.codex/AGENTS.md', '# main\n');
    assert.equal((await sb.run([])).code, 0);
    assert.match(sb.read('.codex', 'AGENTS.md'), /talk-like-akane:start/);
    sb.write('.codex/AGENTS.override.md', '# now active\n');
    const { code, report } = await statusOf(sb);
    assert.equal(code, 3);
    assert.equal(report.installs[0].targets.codex.agents.state, 'OVERRIDDEN');
    const up = await sb.run(['update']);
    assert.equal(up.code, 0, up.err);
    assert.match(up.out, /moved the Akane block from AGENTS\.md to AGENTS\.override\.md/);
    assert.equal(sb.read('.codex', 'AGENTS.md'), '# main\n');
    assert.match(sb.read('.codex', 'AGENTS.override.md'), /talk-like-akane:start/);
    assert.equal((await statusOf(sb)).report.installs[0].targets.codex.agents.state, 'ACTIVE');
  } finally {
    sb.cleanup();
  }
});

test('Codex: project guidance and project_doc_max_bytes limits are surfaced', async () => {
  const sb = makeSandbox({ codex: true });
  try {
    sb.write('.codex/config.toml', 'project_doc_max_bytes = 200\n');
    fs.writeFileSync(path.join(sb.project, 'AGENTS.md'), '# project rules: always answer formally\n');
    assert.equal((await sb.run([])).code, 0);
    const t = (await statusOf(sb)).report.installs[0].targets.codex;
    assert.ok(t.info.some((i) => /project guidance .*AGENTS\.md.* wins on conflicts/.test(i)));
    assert.ok(t.warnings.some((w) => /project_doc_max_bytes=200.*NEEDS_VERIFICATION/.test(w)));
    assert.ok(t.info.some((i) => /Remote and cloud Codex environments/.test(i)));
  } finally {
    sb.cleanup();
  }
});

test('Codex project scope: untrusted project hooks are TRUST_PENDING, not active', async () => {
  const sb = makeSandbox({ codex: true });
  try {
    assert.equal((await sb.run(['install', '--scope', 'project'])).code, 0);
    let t = (await statusOf(sb)).report.installs[0].targets.codex;
    assert.equal(t.hook.state, 'TRUST_PENDING');
    assert.match(t.hook.detail, /project is not trusted/);
    sb.write('.codex/config.toml', `[projects.${JSON.stringify(fs.realpathSync(sb.project))}]\ntrust_level = "trusted"\n`);
    t = (await statusOf(sb)).report.installs[0].targets.codex;
    assert.equal(t.hook.state, 'TRUST_PENDING');
    assert.match(t.hook.detail, /review new hooks/);
  } finally {
    sb.cleanup();
  }
});

test('mini TOML reader: quoted keys with colons, dotted keys, comments, multi-line arrays and strings', () => {
  const t = parseTomlLite(
    [
      'model = "gpt" # comment',
      'project_doc_max_bytes = 65_536',
      'features.hooks = false',
      'arr = [',
      '  "[not.a.table]",',
      ']',
      'doc = """',
      '[also.not.a.table]',
      '"""',
      '[hooks.state."/home/u/.codex/hooks.json:session_start:2:0"]',
      'trusted_hash = "sha256:x"',
      'enabled = true',
      "[projects.'/w/repo']",
      'trust_level = "trusted"',
    ].join('\n'),
  );
  assert.equal(t.get('').model, 'gpt');
  assert.equal(t.get('').project_doc_max_bytes, 65536);
  assert.equal(t.get('features').hooks, false);
  assert.ok(!t.has('not\u0000a\u0000table') && !t.has('also\u0000not\u0000a\u0000table'));
  assert.equal(t.get('projects\u0000/w/repo').trust_level, 'trusted');
  const e = findTrustEntry(t, '/home/u/.codex/hooks.json', 2, 'linux');
  assert.equal(e.trusted_hash, 'sha256:x');
  assert.equal(findTrustEntry(t, '/home/u/.codex/hooks.json', 0, 'linux'), null);
});
