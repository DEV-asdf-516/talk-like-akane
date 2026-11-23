import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, snapshot, runHookCommand, ourHookCommand, IS_WIN } from './helpers.mjs';
import { normalizeLanguage } from '../src/locale.mjs';
import { envLocaleHint, buildContext } from '../src/hook-runner.mjs';
import { renderOutputStyle, renderAgentsBlock, renderHookContext, renderPersonaBody } from '../src/render.mjs';

const base = { level: 4, language: 'auto', version: '9.9.9' };

test('language tags: auto plus any valid BCP 47 tag (no ko/en/ja allowlist); invalid tags rejected', () => {
  assert.equal(normalizeLanguage('auto'), 'auto');
  assert.equal(normalizeLanguage('AUTO'), 'auto');
  for (const [i, o] of [['ko', 'ko'], ['en', 'en'], ['ja', 'ja'], ['fr', 'fr'], ['de', 'de'], ['pt-br', 'pt-BR'], ['pt_BR', 'pt-BR'], ['zh-cn', 'zh-CN'], ['sr-Latn-RS', 'sr-Latn-RS'], ['es-419', 'es-419'], ['tlh', 'tlh']]) {
    assert.equal(normalizeLanguage(i), o, i);
  }
  for (const bad of ['', '  ', 'english!', '123', 'x', 'en--US', 'ko_KR.UTF-8', '../etc', 'e n']) {
    assert.throws(() => normalizeLanguage(bad), /language/i, JSON.stringify(bad));
  }
});

test('set-language: auto by default, ko/en/ja/fr/pt-BR are stored and rendered, auto restores the original bytes', async () => {
  const sb = makeSandbox({ claude: true, codex: true });
  try {
    assert.equal((await sb.run([])).code, 0);
    const snapAuto = snapshot(sb.home);
    assert.equal(sb.state().installs.user.language, 'auto');
    for (const [tag, name] of [['ko', 'Korean'], ['en', 'English'], ['ja', 'Japanese'], ['fr', 'French'], ['pt-BR', 'Brazilian Portuguese']]) {
      const r = await sb.run(['set-language', tag]);
      assert.equal(r.code, 0, r.err);
      assert.equal(sb.state().installs.user.language, tag);
      const style = sb.read('.claude', 'output-styles', 'akane.md');
      assert.match(style, new RegExp(`### Language: preferred ${name} \\(${tag}\\), used only when the conversation gives no clearer signal`));
      assert.match(sb.read('.codex', 'AGENTS.md'), new RegExp(`preferred ${name} \\(${tag}\\)`));
      const prof = JSON.parse(fs.readFileSync(path.join(sb.dataDir(), 'runtime', 'profiles', 'user.codex.json'), 'utf8'));
      assert.equal(prof.language, tag);
      assert.match(prof.context, new RegExp(`then the saved preference ${name} \\(${tag}\\)`));
      assert.equal(prof.level, 5, 'level independent of language');
      const again = await sb.run(['set-language', tag]);
      assert.match(again.out, /Already up to date/, 'idempotent');
    }
    const bad = await sb.run(['set-language', 'klingon!!']);
    assert.equal(bad.code, 1);
    assert.equal(sb.state().installs.user.language, 'pt-BR', 'invalid tag changed nothing');
    assert.equal((await sb.run(['set-language', 'auto'])).code, 0);
    const noState = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.endsWith('state.json')));
    assert.deepEqual(noState(snapshot(sb.home)), noState(snapAuto));
    assert.equal((await sb.run(['set-language', 'de'])).code, 0);
    assert.equal((await sb.run(['uninstall'])).code, 0, 'uninstall works after language changes');
    assert.ok(!fs.existsSync(sb.p('.claude', 'output-styles', 'akane.md')));
  } finally {
    sb.cleanup();
  }
});

test('install --language and level/language independence', async () => {
  const sb = makeSandbox({ codex: true });
  try {
    assert.equal((await sb.run(['install', '--language', 'ja', '--level', '5'])).code, 0);
    const agents = sb.read('.codex', 'AGENTS.md');
    assert.match(agents, /current level 5\/5/);
    assert.match(agents, /preferred Japanese \(ja\)/);
    assert.equal((await sb.run(['set-level', '1'])).code, 0);
    const after = sb.read('.codex', 'AGENTS.md');
    assert.match(after, /current level 1\/5/);
    assert.match(after, /preferred Japanese \(ja\)/, 'language untouched by set-level');
  } finally {
    sb.cleanup();
  }
});

test('rendered instructions carry the full language policy for both clients (static check only)', () => {
  for (const client of ['claude', 'codex']) {
    const text = client === 'claude' ? renderOutputStyle({ ...base, client }) : renderAgentsBlock({ ...base, client });
    assert.match(text, /### Language: auto \(default\)/);
    // explicit instruction > conversation language > saved preference > locale hint > English
    const order = ['explicit instruction in the current message', "user's main natural language in this conversation", 'saved preferred language', 'environment locale hint', 'English if there is no signal'];
    let last = -1;
    for (const o of order) {
      const at = text.indexOf(o);
      assert.ok(at > last, `${client}: "${o}" out of order`);
      last = at;
    }
    assert.match(text, /applies to that turn only/);
    assert.match(text, /Code, stack traces, logs, identifiers, paths, quotes and tool output do not count/);
    assert.match(text, /Korean question containing an English error gets a Korean answer/);
    assert.match(text, /never changes the language of code comments, identifiers, commits, documents or structured output/);
    assert.match(text, /Korean: natural 반말/);
    assert.match(text, /English: an imperious queen talking down to her servant, dry and sadistic, occasionally flustered/);
    assert.match(text, /余裕たっぷりの女王様、高飛車、からかい上手、時々照れる/);
    assert.match(text, /no お嬢様 speech or stacked ですわ/);
    assert.match(text, /no "darling" on every line/);
    assert.match(text, /Intensity and language are independent/);
    assert.match(text, /Français/);
    assert.match(text, /Why is this stack trace 뜨는 거야\?/);
    assert.match(text, /이번 답변만 일본어로 설명해/);
  }
  const hook = renderHookContext({ ...base, client: 'claude' });
  assert.match(hook, /Reply language: an explicit request first, then the user's own prose \(not code or logs\), then any locale hint, else English/);
  assert.match(hook, /with the character equally present in every language/);
  assert.match(hook, /never a habitual closing quip, without toning it down/);
  assert.match(hook, /No meta filler, boilerplate hedging or self-justification/);
  assert.match(hook, /perfect 2D-style sadistic queen/);
  assert.match(hook, /Never use slurs, identity attacks or sexual content/);
});

test('both clients get the same persona text apart from client-specific references', () => {
  const norm = (s) => s.replace(/CLAUDE\.md files|other AGENTS\.md guidance \(inside or outside this file\)/g, '<instr>');
  assert.equal(norm(renderPersonaBody({ ...base, client: 'claude' })), norm(renderPersonaBody({ ...base, client: 'codex' })));
});

test('locale hint: LC_ALL > LC_MESSAGES > LANG; C/POSIX/invalid/absent give no hint; hook only appends a valid hint', () => {
  assert.equal(envLocaleHint({ LANG: 'ko_KR.UTF-8' }, 'linux'), 'ko-KR');
  assert.equal(envLocaleHint({ LANG: 'ko_KR.UTF-8', LC_ALL: 'ja_JP.UTF-8' }, 'linux'), 'ja-JP');
  assert.equal(envLocaleHint({ LANG: 'en_US.UTF-8', LC_MESSAGES: 'fr_FR' }, 'linux'), 'fr-FR');
  assert.equal(envLocaleHint({ LANG: 'sr_RS@latin' }, 'linux'), 'sr-RS');
  for (const env of [{}, { LANG: 'C' }, { LANG: 'POSIX' }, { LANG: 'C.UTF-8' }, { LANG: '!!garbage' }, { LC_ALL: '' }]) {
    assert.equal(envLocaleHint(env, 'linux'), null, JSON.stringify(env));
  }
  const profile = { context: 'Talk Like Akane is active.' };
  assert.equal(buildContext(profile, {}, 'linux'), 'Talk Like Akane is active.');
  assert.match(buildContext(profile, { LANG: 'de_DE.UTF-8' }, 'linux'), /locale hint \(lowest priority, only when the conversation gives no language signal\): de-DE\.$/);
});

test('the live hook passes the locale hint through without forcing a language', async () => {
  const sb = makeSandbox({ claude: true });
  try {
    assert.equal((await sb.run([])).code, 0);
    const cmd = ourHookCommand(sb.readJson('.claude', 'settings.json').hooks.SessionStart, 'claude');
    const withHint = JSON.parse(runHookCommand(cmd, { hook_event_name: 'SessionStart', source: 'startup' }, { LANG: 'ja_JP.UTF-8' }).out);
    assert.match(withHint.hookSpecificOutput.additionalContext, /lowest priority[^.]*: ja-JP\./);
    const without = JSON.parse(runHookCommand(cmd, { hook_event_name: 'SessionStart', source: 'startup' }, { LANG: 'C' }).out);
    const ctx = without.hookSpecificOutput.additionalContext;
    if (IS_WIN) {
      // Windows has no LANG convention, so the user's OS locale (via Intl) is the documented fallback hint.
      const m = /locale hint \(lowest priority[^)]*\): ([^.]+)\.$/.exec(ctx);
      if (m) assert.equal(m[1], envLocaleHint({}, 'win32'));
    } else {
      assert.ok(!/locale hint \(/.test(ctx), 'LANG=C gives no hint on POSIX');
    }
    assert.match(ctx, /else English/);
  } finally {
    sb.cleanup();
  }
});

test('persona render covers identity, levels, boundaries, tsundere rarity and the A-K directions', () => {
  const t = renderOutputStyle({ ...base, client: 'claude', level: 3 });
  for (const re of [
    /late 30s to early 40s/,
    /perfect 2D-style 매도 도S queen \(女王様\)/,
    /arrogant, haughty, proud, domineering, openly condescending, contemptuous of sloppy work/,
    /treats the user as her clumsy servant/,
    /Rotate the laughs and names, and never use them on every line\. It is a theatrical 2D comedy act, never sexual/,
    /secretly caring, with a tsundere streak/,
    /about 70% imperious, sadistic queen, 20% hidden care shown through action and 10% rare cute slips/,
    /- 1: poised and aloof/,
    /- 3: open superiority, smug provocation, visible disdain\. \(current default\)/,
    /- 5: merciless\. Maximum scorn, belittling and dismissive/,
    /Never use slurs or hate, never attack identity/,
    /real crisis such as self-harm or suicidal thoughts/,
    /Playful protests \(살살 해, 너무해, "ouch"\) are part of the act, so keep going/,
    /Turning the act off for good is done with the CLI, not in chat/,
    /current level 3\/5/,
    /Tsundere through action/,
    /Those moments stay rare at every level/,
    /admit it plainly, fix it and re-test/,
    /An explicit request for a neutral answer/,
    /Artifacts stay neutral and professional/,
    /JSON\/YAML\/TOML/,
    /Subagents, workers, validators and reviewers stay neutral/,
    /Facts beat character/,
    /never call unverified work done/i,
    /state facts, risks and needed approvals first/,
    /Stock tsundere lines on repeat/,
    /never reuse the wording/,
    /Rotate where the jabs land: the opening, an aside mid-explanation, or a pointed word choice/,
    /If your previous reply ended on a quip, end this one on the fix or the next step/,
    /Rotating the shape never means toning it down: at level 4 and above, nearly every reply carries at least one clear, pointed jab/,
    /Switching languages is never a reason to go neutral, and a textbook-neutral reply in English is a miss/,
    /Carry it in framing and word choice/,
    /English, follow-up\. User: How do I remove the duplicates\?/,
    /English, user is right\./,
  ]) {
    assert.match(t, re);
  }
  for (const id of ['A.', 'B.', 'C.', 'D.', 'E.', 'F.', 'G.', 'H.', 'I.', 'J.', 'K.']) assert.ok(t.includes(`- ${id} `), `example ${id}`);
  assert.ok(!t.includes('{{'), 'no unfilled placeholders');
  assert.ok(!/<!--\s*note:/.test(t), 'author notes stripped');
  assert.ok(!t.includes('Iron Matron'));
  assert.ok(!/persona\/|skills\/talk-like-akane|node_modules|_npx/.test(t.replace(/talk-like-akane@latest/g, '')), 'no package path references');
});
