// Renders the single persona source (persona/*.md) into self-contained client artifacts.
// Generated text never references package paths, so it keeps working after the npx cache is gone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { languageName } from './locale.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const pkgRoot = () => PKG_ROOT;

export const BLOCK_START = '<!-- talk-like-akane:start -->';
export const BLOCK_END = '<!-- talk-like-akane:end -->';
export const STYLE_NAME = 'Akane';
export const LEVELS = [1, 2, 3, 4, 5];
export const DEFAULT_LEVEL = 4;

let cachedVersion;
export function packageVersion() {
  cachedVersion ??= JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
  return cachedVersion;
}

const readSource = (rel) => fs.readFileSync(path.join(PKG_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripNotes = (s) => s.replace(/<!--\s*note:[\s\S]*?-->\n?/g, '');

let cachedSources;
export function loadSources() {
  if (cachedSources) return cachedSources;
  const persona = stripNotes(readSource('persona/persona.md'));
  const m = persona.match(/<!-- hook-context:start -->\n([\s\S]*?)\n<!-- hook-context:end -->/);
  if (!m) throw new Error('persona/persona.md: hook-context section is missing');
  cachedSources = {
    persona: persona.replace(m[0], '').trim(),
    hookContext: m[1].trim(),
    dialogues: stripNotes(readSource('persona/dialogues.md')).trim(),
    locale: stripNotes(readSource('persona/locale-examples.md')).trim(),
    skill: readSource('skills/talk-like-akane/SKILL.md'),
  };
  return cachedSources;
}

const CLIENT_TEXT = {
  claude: {
    instructionFiles: 'CLAUDE.md files',
    fullRulesRef: 'the Akane output style',
    mechanism:
      'The `Akane` output style shapes every reply in the main conversation, and a SessionStart hook adds a short reminder to every new, resumed, cleared, compacted or forked session',
    managedFiles: 'settings.json, the Akane output style, its SessionStart hook entry or this skill',
    clientNote:
      'Project settings win over user settings. If a project sets another `outputStyle` (for example via `/output-style`, which saves to `.claude/settings.local.json`), Akane is overridden in that project. `status` reports it.',
  },
  codex: {
    instructionFiles: 'other AGENTS.md guidance (inside or outside this file)',
    fullRulesRef: 'the talk-like-akane block in AGENTS.md',
    mechanism:
      'The talk-like-akane block in the global AGENTS.md applies to every session. A SessionStart hook adds a short reminder once the user has trusted it in `/hooks`',
    managedFiles: 'AGENTS.md, AGENTS.override.md, hooks.json, config.toml or this skill',
    clientNote:
      'Codex may ask the user to review the new hook in `/hooks`. Trusting it is the user\'s decision. Never trust it on their behalf. Akane already works from AGENTS.md without it.',
  },
};

function vars({ client, level, language, version }) {
  if (!CLIENT_TEXT[client]) throw new Error(`render: unknown client ${client}`);
  if (!LEVELS.includes(level)) throw new Error(`render: invalid level ${level}`);
  const name = languageName(language);
  return {
    ...CLIENT_TEXT[client],
    version,
    level,
    languageMode:
      language === 'auto'
        ? "auto (default). Follow the user's language every turn"
        : `preferred ${name} (${language}), used only when the conversation gives no clearer signal`,
    preferredLanguageLine: language === 'auto' ? '(none saved, mode is auto)' : `(${name}, ${language})`,
    languageShort: language === 'auto' ? 'auto' : `${language} preferred`,
    preferenceClause: language === 'auto' ? '' : `, then the saved preference ${name} (${language})`,
  };
}

export function fill(template, v) {
  return template.replace(/\{\{([a-zA-Z]+)(?::(\d))?\}\}/g, (all, key, n) => {
    if (key === 'current') return Number(n) === v.level ? ' (current default)' : '';
    if (!(key in v)) throw new Error(`render: unknown placeholder ${all}`);
    return String(v[key]);
  });
}

function managedComment({ version, level, language }) {
  return `<!-- Managed by talk-like-akane v${version} (level ${level}/5, language ${language}). Do not edit by hand. Change it with: npx -y talk-like-akane@latest set-level <1-5>, set-language <auto or tag>, or uninstall. -->`;
}

const INTRO =
  'Speak as **Akane** in your user-facing replies, starting with the first reply of every session. No one has to ask for it or run a command. The rules below shape tone only.';

export function renderPersonaBody(opts) {
  const s = loadSources();
  return [INTRO, fill(s.persona, vars(opts)), s.dialogues, s.locale].join('\n\n') + '\n';
}

export function renderOutputStyle(opts) {
  return [
    '---',
    `name: ${STYLE_NAME}`,
    'description: Akane, an arrogant, teasing, secretly caring senior-engineer voice for user-facing replies. Code and artifacts stay neutral. Managed by talk-like-akane.',
    'keep-coding-instructions: true',
    '---',
    managedComment(opts),
    '',
    '# Akane persona',
    '',
    renderPersonaBody(opts),
  ].join('\n');
}

export function renderAgentsBlock(opts, eol = '\n') {
  const text = [BLOCK_START, managedComment(opts), '', '## Akane persona (talk-like-akane)', '', renderPersonaBody(opts).trimEnd(), BLOCK_END].join('\n');
  return eol === '\n' ? text : text.replace(/\n/g, eol);
}

export function renderHookContext(opts) {
  return fill(loadSources().hookContext, vars(opts)).replace(/\s*\n\s*/g, ' ').trim();
}

export function renderSkill(opts) {
  return fill(loadSources().skill, vars(opts));
}

export function renderProfile(opts, { scope, profileId, projectRoot }) {
  const profile = {
    schema: 1,
    tool: 'talk-like-akane',
    version: opts.version,
    client: opts.client,
    profileId,
    scope,
    projectRoot: projectRoot ?? null,
    level: opts.level,
    language: opts.language,
    context: renderHookContext(opts),
  };
  return JSON.stringify(profile, null, 2) + '\n';
}
