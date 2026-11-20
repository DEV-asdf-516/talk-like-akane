// Read-only diagnostics. Never writes anything. Distinguishes "installed" from "verified active".
import fs from 'node:fs';
import path from 'node:path';
import { detectClients, evidence } from './detect.mjs';
import * as P from './paths.mjs';
import { loadState } from './state.mjs';
import { packageVersion, pkgRoot, STYLE_NAME } from './render.mjs';
import { findOwnGroups } from './hooks.mjs';
import { claudeLocations } from './claude.mjs';
import { codexLocations, effectiveAgentsFile, findBlock } from './codex.mjs';
import { findProjectRoot, CLIENT_NAMES } from './install.mjs';
import { describeLanguage } from './locale.mjs';
import { inspect, readBytesOrNull, sha256, displayPath, isWithin, EXIT } from './util.mjs';

const DEGRADED = new Set(['OVERRIDDEN', 'MISSING', 'MODIFIED', 'BROKEN', 'INACTIVE', 'CONFLICT']);

// ---------------- tiny read-only TOML reader (only what diagnostics need) ----------------

function parseKeyPath(s) {
  const parts = [];
  let i = 0;
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      try {
        parts.push(JSON.parse(s.slice(i, j + 1)));
      } catch {
        parts.push(s.slice(i + 1, j));
      }
      i = j + 1;
    } else if (s[i] === "'") {
      const j = s.indexOf("'", i + 1);
      parts.push(s.slice(i + 1, j === -1 ? s.length : j));
      i = j === -1 ? s.length : j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) return null;
      parts.push(m[0]);
      i += m[0].length;
    }
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (i < s.length) {
      if (s[i] !== '.') return null;
      i++;
    }
  }
  return parts;
}

function parseScalar(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(v);
    if (m) {
      try {
        return JSON.parse(`"${m[1]}"`);
      } catch {
        return m[1];
      }
    }
    return undefined;
  }
  if (v.startsWith("'")) {
    const m = /^'([^']*)'/.exec(v);
    return m ? m[1] : undefined;
  }
  const bare = v.replace(/\s+#.*$/, '').trim();
  if (bare === 'true') return true;
  if (bare === 'false') return false;
  if (/^[+-]?\d[\d_]*$/.test(bare)) return Number(bare.replace(/_/g, ''));
  return undefined;
}

/** Returns Map<tablePathJoinedBy\u0000, Record<key, scalar>>. Unknown or complex values are skipped. */
export function parseTomlLite(text) {
  const tables = new Map([['', {}]]);
  let cur = '';
  let skipUntil = null;
  let depth = 0;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (skipUntil) {
      if (line.includes(skipUntil)) skipUntil = null;
      continue;
    }
    if (depth > 0) {
      for (const ch of line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '')) depth += ch === '[' ? 1 : ch === ']' ? -1 : 0;
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    const header = /^\[(\[?)\s*(.+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header && !line.includes('=')) {
      const parts = parseKeyPath(header[2]);
      cur = parts ? parts.join('\u0000') : '\u0001invalid';
      if (!tables.has(cur)) tables.set(cur, {});
      continue;
    }
    const eq = /^((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.\- \t])+?)\s*=\s*(.*)$/.exec(line);
    if (!eq) continue;
    const keyParts = parseKeyPath(eq[1].trim());
    const value = eq[2];
    if (/^("""|''')/.test(value) && !value.slice(3).includes(value.slice(0, 3))) {
      skipUntil = value.slice(0, 3);
      continue;
    }
    if (value.startsWith('[') || value.startsWith('{')) {
      for (const ch of value.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '')) depth += ch === '[' || ch === '{' ? 1 : ch === ']' || ch === '}' ? -1 : 0;
      if (depth < 0) depth = 0;
      continue;
    }
    if (!keyParts) continue;
    const tableKey = [cur, ...keyParts.slice(0, -1)].filter((x) => x !== '').join('\u0000');
    if (!tables.has(tableKey)) tables.set(tableKey, {});
    tables.get(tableKey)[keyParts[keyParts.length - 1]] = parseScalar(value);
  }
  return tables;
}

function readToml(file) {
  const b = readBytesOrNull(file);
  if (!b) return null;
  try {
    return parseTomlLite(b.toString('utf8'));
  } catch {
    return null;
  }
}

// ---------------- helpers ----------------

function readJsonSafe(file) {
  const b = readBytesOrNull(file);
  if (!b) return { exists: false, data: null };
  try {
    const t = b.toString('utf8').replace(/^\uFEFF/, '');
    return { exists: true, data: t.trim() ? JSON.parse(t) : {} };
  } catch (e) {
    return { exists: true, data: null, error: `invalid JSON (${e.message})` };
  }
}

function ownedFileState(rec) {
  if (!rec) return { state: 'MISSING', path: null };
  const b = readBytesOrNull(rec.path);
  if (!b) return { state: 'MISSING', path: rec.path };
  return { state: sha256(b) === rec.sha256 ? 'OK' : 'MODIFIED', path: rec.path };
}

function readMarker(ctx, profileId, client) {
  const b = readBytesOrNull(P.markerPath(ctx, profileId, client));
  if (!b) return null;
  try {
    return JSON.parse(b.toString('utf8'));
  } catch {
    return null;
  }
}

function hookRuntimeProblem(ctx, command) {
  if (!fs.existsSync(P.runnerPath(ctx))) return `hook runner missing at ${P.runnerPath(ctx)}`;
  if (ctx.platform !== 'win32') {
    const m = /^'((?:[^']|'\\'')*)'/.exec(command || '');
    const node = m ? m[1].replace(/'\\''/g, "'") : null;
    if (node && !fs.existsSync(node)) return `Node.js binary used by the hook no longer exists: ${node} (run update)`;
  }
  return null;
}

function markerVerdict(marker, registeredAt) {
  if (!marker || !registeredAt) return null;
  if (Date.parse(marker.at) >= Date.parse(registeredAt)) {
    const how = marker.injected ? 'injected the Akane reminder' : `skipped (${marker.reason})`;
    return `last ran ${marker.at}${marker.source ? ` (source: ${marker.source})` : ''} and ${how}`;
  }
  return null;
}

function truthyEnv(v) {
  return ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());
}

function scanForcedPluginStyles(ctx) {
  const root = path.join(P.claudeHome(ctx), 'plugins');
  const hits = [];
  let budget = 4000;
  const walk = (dir, depth) => {
    if (depth > 7 || budget <= 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (--budget <= 0) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.md') && path.basename(dir) === 'output-styles') {
        const b = readBytesOrNull(p);
        if (b && /^force-for-plugin:\s*true\s*$/m.test(b.toString('utf8').split(/\n---/)[0])) hits.push(p);
      }
    }
  };
  walk(root, 0);
  return hits;
}

// ---------------- Claude Code ----------------

function claudeStatus(ctx, inst, rec, where) {
  const warnings = [];
  const info = [];
  const loc = claudeLocations(ctx, inst.scope, inst.projectRoot);
  const files = { skill: ownedFileState(rec.files?.skill), style: ownedFileState(rec.files?.style) };

  // outputStyle precedence: managed > project local > project shared > user.
  const userSettings = readJsonSafe(path.join(P.claudeHome(ctx), 'settings.json'));
  const roots = inst.scope === 'project' ? [inst.projectRoot] : [...new Set([where.projectRoot, where.cwd].filter(Boolean))];
  const layers = [];
  for (const f of P.claudeManagedSettingsPaths(ctx)) layers.push({ file: f, kind: 'managed policy', ...readJsonSafe(f) });
  const userClaudeDir = path.resolve(P.claudeHome(ctx));
  for (const r of roots) {
    layers.push({ file: path.join(r, '.claude', 'settings.local.json'), kind: 'project local', ...readJsonSafe(path.join(r, '.claude', 'settings.local.json')) });
    // Running from the home directory: the "project" settings.json is the user file itself.
    if (path.resolve(r, '.claude') !== userClaudeDir) layers.push({ file: path.join(r, '.claude', 'settings.json'), kind: 'project', ...readJsonSafe(path.join(r, '.claude', 'settings.json')) });
  }
  layers.push({ file: path.join(P.claudeHome(ctx), 'settings.json'), kind: 'user', ...userSettings });
  for (const l of layers) if (l.error) warnings.push(`${l.file}: ${l.error}`);
  const effective = layers.find((l) => l.data && Object.hasOwn(l.data, 'outputStyle'));
  const own = readJsonSafe(rec.settings.path);
  let outputStyle;
  if (!own.data || own.data.outputStyle !== STYLE_NAME) {
    outputStyle = { state: 'INACTIVE', detail: own.data ? `outputStyle in ${rec.settings.path} is ${JSON.stringify(own.data.outputStyle ?? null)}, not "${STYLE_NAME}"` : `${rec.settings.path} unreadable` };
  } else if (effective && effective.data.outputStyle !== STYLE_NAME) {
    outputStyle = { state: 'OVERRIDDEN', detail: `${effective.kind} setting ${effective.file} selects "${effective.data.outputStyle}"` };
  } else {
    outputStyle = { state: 'ACTIVE', detail: `outputStyle "${STYLE_NAME}" from ${effective?.file ?? rec.settings.path}` };
  }
  if (files.style.state !== 'OK') outputStyle = { state: files.style.state === 'MISSING' ? 'BROKEN' : outputStyle.state, detail: `style file ${files.style.state.toLowerCase()}: ${loc.style}` };
  // A nearer project style file named Akane would shadow ours (nearest wins).
  if (inst.scope === 'user') {
    for (const r of roots) {
      const dir = path.join(r, '.claude', 'output-styles');
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
      } catch {
        /* none */
      }
      for (const n of names) {
        if (path.resolve(dir, n) === path.resolve(rec.files?.style?.path ?? '')) continue; // our own style file
        const b = readBytesOrNull(path.join(dir, n));
        const head = b ? b.toString('utf8').split(/\n---/)[0] : '';
        if (/^name:\s*Akane\s*$/m.test(head) || (n.toLowerCase() === 'akane.md' && !/^name:/m.test(head))) {
          warnings.push(`project output style ${path.join(dir, n)} is also named "Akane" and takes precedence in that project`);
        }
      }
    }
  }
  const forced = scanForcedPluginStyles(ctx);
  if (forced.length) {
    warnings.push(`plugin output style(s) with force-for-plugin: true found (${forced.map((f) => displayPath(f, ctx.home)).join(', ')}). If such a plugin is enabled, its style overrides Akane (NEEDS_VERIFICATION)`);
  }
  if (truthyEnv(ctx.env.CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT)) {
    warnings.push('CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT is set: keep-coding-instructions only takes effect with the full system prompt');
  }

  // SessionStart hook
  let hook;
  const settingsNow = own.data;
  const idx = settingsNow ? findOwnGroups(settingsNow?.hooks?.SessionStart, 'claude', inst.profileId) : [];
  const disabledBy = layers.find((l) => l.data && l.data.disableAllHooks === true);
  const managedOnly = layers.find((l) => l.kind === 'managed policy' && l.data && l.data.allowManagedHooksOnly === true);
  if (idx.length === 0) hook = { state: 'MISSING', detail: `no talk-like-akane SessionStart entry in ${rec.settings.path}` };
  else if (disabledBy) hook = { state: 'OVERRIDDEN', detail: `disableAllHooks is true in ${disabledBy.file}` };
  else if (managedOnly) hook = { state: 'OVERRIDDEN', detail: `allowManagedHooksOnly is set in ${managedOnly.file}` };
  else {
    const problem = hookRuntimeProblem(ctx, settingsNow.hooks.SessionStart[idx[0]]?.hooks?.[0]?.command);
    const ran = markerVerdict(readMarker(ctx, inst.profileId, 'claude'), rec.settings.hookRegisteredAt);
    if (problem) hook = { state: 'BROKEN', detail: problem };
    else if (ran) hook = { state: 'VERIFIED', detail: ran };
    else hook = { state: 'REGISTERED', detail: 'registered in settings; not seen running yet (start a new Claude Code session)' };
  }
  info.push('Output styles apply to the main conversation (and forks), not to other subagents.');
  return { client: 'claude', files, outputStyle, hook, warnings, info };
}

// ---------------- Codex ----------------

function codexStatus(ctx, inst, rec, where) {
  const warnings = [];
  const info = [];
  const loc = codexLocations(ctx, inst.scope, inst.projectRoot);
  const files = { skill: ownedFileState(rec.files?.skill) };
  const config = readToml(path.join(P.codexHome(ctx), 'config.toml'));
  const topLevel = config?.get('') ?? {};
  const features = config?.get('features') ?? {};

  // AGENTS block
  let agents;
  const eff = effectiveAgentsFile(loc.agentsDir);
  if (rec.agents?.path !== eff.file) {
    agents = { state: 'OVERRIDDEN', detail: `Codex now reads ${eff.file}; the Akane block is in ${rec.agents?.path}. Run update to move it` };
  } else {
    const b = readBytesOrNull(eff.file);
    const found = b ? findBlock(b.toString('utf8')) : { state: 'absent' };
    if (found.state === 'present') {
      agents = sha256(found.region) === rec.agents.blockSha256 ? { state: 'ACTIVE', detail: `block in ${eff.file}` } : { state: 'MODIFIED', detail: `block in ${eff.file} was edited by hand` };
      const limit = Number.isInteger(topLevel.project_doc_max_bytes) ? topLevel.project_doc_max_bytes : 32 * 1024;
      if (Buffer.byteLength(b.toString('utf8').slice(0, found.end), 'utf8') > limit) {
        agents.detail += `; the file exceeds project_doc_max_bytes (${limit}) before the block ends, so Codex may truncate it (NEEDS_VERIFICATION)`;
        warnings.push(`${eff.file} is larger than project_doc_max_bytes=${limit}; the Akane block may be cut off (NEEDS_VERIFICATION)`);
      }
    } else if (found.state === 'corrupt') agents = { state: 'CONFLICT', detail: `damaged markers in ${eff.file}` };
    else agents = { state: 'MISSING', detail: `no Akane block in ${eff.file}` };
  }
  if (inst.scope === 'user') {
    const root = where.projectRoot;
    const projectDocs = [];
    for (let d = path.resolve(where.cwd); ; d = path.dirname(d)) {
      for (const n of ['AGENTS.override.md', 'AGENTS.md']) if (fs.existsSync(path.join(d, n))) projectDocs.push(path.join(d, n));
      if (!isWithin(d, root, ctx.platform) || d === root || path.dirname(d) === d) break;
    }
    if (projectDocs.length) info.push(`project guidance (${projectDocs.map((f) => displayPath(f, ctx.home)).join(', ')}) is read after the global file and wins on conflicts; Akane yields to it by design`);
  }

  // SessionStart hook + trust
  let hook;
  const hooksJson = readJsonSafe(rec.hooks.path);
  const list = hooksJson.data?.hooks?.SessionStart;
  const idx = findOwnGroups(list, 'codex', inst.profileId);
  const requirements = P.codexRequirementsPaths(ctx).map(readToml).filter(Boolean);
  const managedOnly = requirements.some((t) => t.get('')?.allow_managed_hooks_only === true || t.get('hooks')?.allow_managed_hooks_only === true);
  if (hooksJson.error) hook = { state: 'BROKEN', detail: `${rec.hooks.path}: ${hooksJson.error}` };
  else if (idx.length === 0) hook = { state: 'MISSING', detail: `no talk-like-akane SessionStart entry in ${rec.hooks.path}` };
  else if (features.hooks === false || features.codex_hooks === false) hook = { state: 'OVERRIDDEN', detail: 'hooks are disabled in config.toml [features]' };
  else if (managedOnly) hook = { state: 'OVERRIDDEN', detail: 'requirements.toml allows managed hooks only' };
  else {
    const problem = hookRuntimeProblem(ctx, list[idx[0]]?.hooks?.[0]?.command);
    const ran = markerVerdict(readMarker(ctx, inst.profileId, 'codex'), rec.hooks.hookRegisteredAt);
    const trust = findTrustEntry(config, rec.hooks.path, idx[0], ctx.platform);
    const projectTrusted = inst.scope === 'project' ? projectTrustLevel(config, inst.projectRoot, ctx.platform) === 'trusted' : true;
    if (problem) hook = { state: 'BROKEN', detail: problem };
    else if (trust?.enabled === false) hook = { state: 'OVERRIDDEN', detail: 'this hook is disabled in Codex /hooks' };
    else if (ran) hook = { state: 'VERIFIED', detail: ran };
    else if (!projectTrusted) hook = { state: 'TRUST_PENDING', detail: 'this project is not trusted in Codex, so project hooks do not load yet. AGENTS.md still applies' };
    else if (trust?.trusted_hash) {
      hook = { state: 'UNKNOWN', detail: 'Codex has a trust record for this hook slot, but whether it matches the current definition cannot be verified. It becomes VERIFIED after the hook runs once' };
    } else {
      hook = { state: 'TRUST_PENDING', detail: 'Codex asks you to review new hooks before they run. Open /hooks in Codex if you want the extra session-start reminder. Akane already works from AGENTS.md' };
    }
  }
  if (inst.scope === 'user' && ctx.env.CODEX_HOME) info.push(`CODEX_HOME is set; the management skill still lives in ${path.dirname(path.dirname(loc.skill))} (Codex reads user skills from $HOME/.agents/skills)`);
  info.push('Remote and cloud Codex environments do not read your local AGENTS.md or hooks.');
  return { client: 'codex', files, agents, hook, warnings, info };
}

function normPath(p, platform) {
  let r = path.resolve(p);
  try {
    r = fs.realpathSync(r);
  } catch {
    /* keep */
  }
  return platform === 'win32' ? r.toLowerCase().replace(/\\/g, '/') : r;
}

export function findTrustEntry(config, hooksPath, groupIndex, platform) {
  if (!config) return null;
  const want = normPath(hooksPath, platform);
  for (const [k, v] of config) {
    const parts = k.split('\u0000');
    if (parts.length !== 3 || parts[0] !== 'hooks' || parts[1] !== 'state') continue;
    const m = /^(.*):session_start:(\d+):(\d+)$/.exec(parts[2]);
    if (!m || Number(m[2]) !== groupIndex || Number(m[3]) !== 0) continue;
    if (normPath(m[1], platform) === want) return v;
  }
  return null;
}

function projectTrustLevel(config, root, platform) {
  if (!config) return null;
  const want = normPath(root, platform);
  for (const [k, v] of config) {
    const parts = k.split('\u0000');
    if (parts.length === 2 && parts[0] === 'projects' && normPath(parts[1], platform) === want) return v.trust_level ?? null;
  }
  return null;
}

// ---------------- report ----------------

export function computeStatus(ctx, { projectRoot } = {}) {
  const det = detectClients(ctx);
  let st;
  let stateError = null;
  try {
    st = loadState(ctx);
  } catch (e) {
    stateError = e.message;
    st = { data: { installs: {} } };
  }
  const where = { cwd: ctx.cwd, projectRoot: projectRoot ? path.resolve(ctx.cwd, projectRoot) : findProjectRoot(ctx.cwd) };
  const installs = [];
  for (const [key, inst] of Object.entries(st.data.installs)) {
    const targets = {};
    for (const [client, rec] of Object.entries(inst.targets ?? {})) {
      try {
        targets[client] = client === 'claude' ? claudeStatus(ctx, inst, rec, where) : codexStatus(ctx, inst, rec, where);
      } catch (e) {
        targets[client] = { client, error: e.message, warnings: [], info: [] };
      }
    }
    installs.push({ key, scope: inst.scope, projectRoot: inst.projectRoot, level: inst.level, language: inst.language, version: inst.version, installedAt: inst.installedAt, updatedAt: inst.updatedAt, outdated: inst.version !== packageVersion(), targets });
  }
  const runnerBytes = readBytesOrNull(P.runnerPath(ctx));
  const pkgRunner = readBytesOrNull(path.join(pkgRoot(), 'src', 'hook-runner.mjs'));
  const orphans = st.data.installs.user ? [] : findOrphans(ctx);
  return {
    tool: 'talk-like-akane',
    cliVersion: packageVersion(),
    dataDir: P.dataDir(ctx),
    stateError,
    detected: { claude: { ...det.claude, evidence: evidence(det.claude) }, codex: { ...det.codex, evidence: evidence(det.codex) } },
    runtime: { runner: P.runnerPath(ctx), present: !!runnerBytes, matchesThisVersion: !!runnerBytes && !!pkgRunner && runnerBytes.equals(pkgRunner) },
    installs,
    orphans,
  };
}

function findOrphans(ctx) {
  const out = [];
  const c = claudeLocations(ctx, 'user');
  for (const f of [c.skill, c.style]) if (inspect(f).exists) out.push(f);
  const x = codexLocations(ctx, 'user');
  if (inspect(x.skill).exists) out.push(x.skill);
  const eff = effectiveAgentsFile(x.agentsDir);
  const b = readBytesOrNull(eff.file);
  if (b && findBlock(b.toString('utf8')).state !== 'absent') out.push(`${eff.file} (Akane block)`);
  return out;
}

export function statusExitCode(report) {
  if (report.stateError) return EXIT.CONFLICT;
  if (report.installs.length === 0) return EXIT.NOTHING;
  for (const inst of report.installs) {
    for (const t of Object.values(inst.targets)) {
      if (t.error) return EXIT.CONFLICT;
      const states = [t.outputStyle?.state, t.agents?.state, t.hook?.state, ...Object.values(t.files ?? {}).map((f) => f.state)];
      if (states.some((s) => DEGRADED.has(s))) return EXIT.CONFLICT;
    }
  }
  return EXIT.OK;
}

const pad = (s, n) => (s + ' '.repeat(n)).slice(0, Math.max(n, s.length));

export function formatTarget(ctx, t) {
  const dp = (p) => (p ? displayPath(p, ctx.home) : '');
  const lines = [];
  lines.push(`  ${CLIENT_NAMES[t.client]}`);
  if (t.error) {
    lines.push(`    error: ${t.error}`);
    return lines;
  }
  const short = (s) => (s && ctx.home ? String(s).split(ctx.home).join('~') : s);
  const row = (label, state, detail) => lines.push(`    ${pad(label, 18)} ${pad(state, 13)} ${short(detail) ?? ''}`.trimEnd());
  row('management skill', t.files.skill.state, dp(t.files.skill.path));
  if (t.client === 'claude') {
    row('output style file', t.files.style.state, dp(t.files.style.path));
    row('outputStyle', t.outputStyle.state, t.outputStyle.detail);
  } else {
    row('AGENTS block', t.agents.state, t.agents.detail);
  }
  row('SessionStart hook', t.hook.state, t.hook.detail);
  for (const w of t.warnings) lines.push(`    ! ${w}`);
  for (const i of t.info) lines.push(`    - ${i}`);
  return lines;
}

export function formatStatus(ctx, r) {
  const dp = (p) => displayPath(p, ctx.home);
  const out = [];
  out.push(`talk-like-akane ${r.cliVersion} status (read-only)`);
  out.push(`data dir: ${dp(r.dataDir)}`);
  out.push(`detected: Claude Code: ${r.detected.claude.detected ? 'yes' : 'no'} (${r.detected.claude.evidence}); Codex: ${r.detected.codex.detected ? 'yes' : 'no'} (${r.detected.codex.evidence})`);
  if (r.stateError) out.push(`! ${r.stateError}`);
  if (r.installs.length === 0) {
    out.push('', 'Not installed. Install with: npx -y talk-like-akane@latest');
    if (r.orphans.length) out.push(`! Found Akane files without install state: ${r.orphans.map(dp).join(', ')}. They were not created by this installation or its state was lost. Remove them by hand before installing.`);
    return out.join('\n') + '\n';
  }
  for (const inst of r.installs) {
    out.push('');
    out.push(`[${inst.scope === 'user' ? 'user scope' : `project ${inst.projectRoot}`}] level ${inst.level}/5, language ${describeLanguage(inst.language)}, installed version ${inst.version}${inst.outdated ? ` (this CLI is ${r.cliVersion}; run update)` : ''}`);
    for (const t of Object.values(inst.targets)) out.push(...formatTarget(ctx, t));
  }
  if (r.runtime.present && !r.runtime.matchesThisVersion) out.push('', `- hook runner at ${dp(r.runtime.runner)} differs from this CLI version (run update to refresh it)`);
  out.push('', 'States: ACTIVE/VERIFIED = confirmed; REGISTERED = written, not seen running yet; TRUST_PENDING = waiting for your review in Codex /hooks; UNKNOWN = cannot be verified locally; OVERRIDDEN = something with higher precedence wins.');
  return out.join('\n') + '\n';
}
