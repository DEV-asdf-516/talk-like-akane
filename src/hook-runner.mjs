#!/usr/bin/env node
// talk-like-akane SessionStart hook runner.
//
// Installed as a copy in the per-user data directory, never run from the npx cache.
// Self-contained: Node.js built-ins only, with no network, no model calls and no child processes.
// It reads the hook JSON from stdin, picks the pre-rendered persona reminder for this client and
// profile, and prints a SessionStart `additionalContext` payload. On any failure it exits 0 with
// no output (fail-open), so the persistent instructions (output style / AGENTS.md) still apply.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RUNNER_SCHEMA = 1;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DELEGATED_AGENT_RE = /(sub-?agent|worker|validator|reviewer|verifier|grader|judge|critic|evaluator|checker)/i;

export function parseArgs(argv) {
  const out = { client: null, profile: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--client') out.client = argv[++i] ?? null;
    else if (argv[i] === '--profile') out.profile = argv[++i] ?? null;
  }
  if (!/^(claude|codex)$/.test(out.client ?? '')) out.client = null;
  if (!/^[A-Za-z0-9-]{1,40}$/.test(out.profile ?? '')) out.profile = null;
  return out;
}

/** Locale hint from LC_ALL / LC_MESSAGES / LANG, plus the Windows user locale via Intl. Never reads conversations. */
export function envLocaleHint(env, platform = process.platform) {
  for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const v = env[k];
    if (!v) continue;
    const base = String(v).split('.')[0].split('@')[0];
    if (!base || base === 'C' || base === 'POSIX') continue;
    const tag = canonicalTag(base);
    if (tag) return tag;
  }
  if (platform === 'win32') {
    try {
      return canonicalTag(Intl.DateTimeFormat().resolvedOptions().locale);
    } catch {
      return null;
    }
  }
  return null;
}

export function canonicalTag(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim().replace(/_/g, '-');
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(t)) return null;
  try {
    return Intl.getCanonicalLocales(t)[0] ?? null;
  } catch {
    return null;
  }
}

/** Decide whether this SessionStart belongs to the user-facing main session. */
export function shouldInject(input, env) {
  const flag = String(env.TALK_LIKE_AKANE_DISABLE ?? '').toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes') return { inject: false, reason: 'disabled-by-env' };
  if (input && typeof input === 'object') {
    if (input.hook_event_name && input.hook_event_name !== 'SessionStart') return { inject: false, reason: 'not-session-start' };
    if (input.agent_id) return { inject: false, reason: 'subagent' };
    if (input.parent_session_id || input.parent_thread_id) return { inject: false, reason: 'subagent' };
    if (typeof input.agent_type === 'string' && DELEGATED_AGENT_RE.test(input.agent_type)) return { inject: false, reason: 'delegated-agent' };
  }
  return { inject: true, reason: 'main-session' };
}

function sameOrInside(child, parent) {
  const win = process.platform === 'win32';
  const norm = (p) => (win ? path.resolve(p).toLowerCase() : path.resolve(p));
  const c = norm(child);
  const p = norm(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * A user-scope hook steps aside when a project-scope install covers cwd, so the
 * reminder is injected once and the project's level/language wins.
 */
const variants = (p) => {
  const out = [p];
  try {
    out.push(fs.realpathSync(p));
  } catch {
    /* keep as given */
  }
  return out;
};

export function coveredByProjectProfile(runtimeDir, client, cwd) {
  if (!cwd || typeof cwd !== 'string') return false;
  const cwds = variants(cwd);
  let names = [];
  try {
    names = fs.readdirSync(path.join(runtimeDir, 'profiles'));
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith(`.${client}.json`) || name.startsWith('user.')) continue;
    try {
      const p = readJson(path.join(runtimeDir, 'profiles', name));
      if (p.scope === 'project' && p.projectRoot && variants(p.projectRoot).some((root) => cwds.some((c) => sameOrInside(c, root)))) return true;
    } catch {
      /* ignore unreadable profile */
    }
  }
  return false;
}

export function buildContext(profile, env, platform = process.platform) {
  let text = String(profile.context || '').trim();
  const hint = envLocaleHint(env, platform);
  if (hint) text += ` Environment locale hint (lowest priority, only when the conversation gives no language signal): ${hint}.`;
  return text;
}

export function buildOutput(context) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
}

function writeMarker(runtimeDir, args, data) {
  try {
    const dir = path.join(runtimeDir, 'markers');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${args.profile}.${args.client}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schema: RUNNER_SCHEMA, client: args.client, profile: args.profile, ...data }) + '\n');
    fs.renameSync(tmp, file);
  } catch {
    /* markers are diagnostics only */
  }
}

function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        process.stdin.pause();
        process.stdin.destroy();
      } catch {
        /* ignore */
      }
      resolve(data);
    };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => {
        data += c;
        if (data.length > 1_000_000) finish();
      });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch {
      finish();
    }
    setTimeout(finish, timeoutMs).unref();
  });
}

/** Pure core used by main() and by tests. Returns { stdout, marker }. */
export function runOnce({ argv, stdinText, env, runtimeDir = HERE, platform = process.platform, now = new Date() }) {
  const args = parseArgs(argv);
  if (!args.client || !args.profile) return { stdout: '', marker: null };
  let input = {};
  if (stdinText && stdinText.trim()) {
    try {
      input = JSON.parse(stdinText);
    } catch {
      input = {};
    }
  }
  const base = { at: now.toISOString(), source: typeof input.source === 'string' ? input.source : null };
  const decision = shouldInject(input, env);
  if (!decision.inject) return { stdout: '', marker: { args, data: { ...base, injected: false, reason: decision.reason } } };
  const profileFile = path.join(runtimeDir, 'profiles', `${args.profile}.${args.client}.json`);
  let profile;
  try {
    profile = readJson(profileFile);
  } catch (e) {
    return { stdout: '', marker: { args, data: { ...base, injected: false, reason: 'profile-missing', error: String(e && e.code ? e.code : e) } } };
  }
  if (args.profile === 'user' && coveredByProjectProfile(runtimeDir, args.client, input.cwd)) {
    return { stdout: '', marker: { args, data: { ...base, injected: false, reason: 'project-profile-active', version: profile.version } } };
  }
  const context = buildContext(profile, env, platform);
  if (!context) return { stdout: '', marker: { args, data: { ...base, injected: false, reason: 'empty-context' } } };
  return { stdout: buildOutput(context) + '\n', marker: { args, data: { ...base, injected: true, reason: decision.reason, version: profile.version } } };
}

async function main() {
  try {
    const stdinText = await readStdin(1500);
    const res = runOnce({ argv: process.argv.slice(2), stdinText, env: process.env });
    if (res.marker) writeMarker(HERE, res.marker.args, res.marker.data);
    if (res.stdout) process.stdout.write(res.stdout);
  } catch {
    /* fail open: never block the session */
  }
  process.exitCode = 0;
}

const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    const self = norm(fileURLToPath(import.meta.url));
    return self === norm(fs.realpathSync(process.argv[1])) || self === norm(process.argv[1]) || import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
