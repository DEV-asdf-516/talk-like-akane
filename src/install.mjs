// Orchestration: install / update / set-level / set-language (one "reconcile" path) and uninstall.
// Every command plans all changes for all targets first, then applies them atomically. On failure the whole run is rolled back.
import fs from 'node:fs';
import path from 'node:path';
import { Plan, applyPlan } from './tx.mjs';
import { loadState, serializeState, acquireLock, STATE_SCHEMA } from './state.mjs';
import { detectClients, evidence } from './detect.mjs';
import * as P from './paths.mjs';
import { packageVersion, renderProfile, DEFAULT_LEVEL, LEVELS, pkgRoot } from './render.mjs';
import { buildHookCommand } from './hooks.mjs';
import { planClaudeInstall, planClaudeRemove } from './claude.mjs';
import { planCodexInstall, planCodexRemove } from './codex.mjs';
import { TlaError, EXIT, usageError, conflictError, inspect, clone, deepEqual, isWithin } from './util.mjs';

export const CLIENTS = ['claude', 'codex'];
export const CLIENT_NAMES = { claude: 'Claude Code', codex: 'Codex' };
const TARGETS = ['auto', 'claude', 'codex', 'both'];

export function findProjectRoot(start) {
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return path.resolve(start);
    d = up;
  }
}

export function resolveScope(ctx, { scope = 'user', projectRoot } = {}) {
  if (scope !== 'user' && scope !== 'project') throw usageError(`--scope must be "user" or "project" (got "${scope}").`);
  if (scope === 'user') {
    if (projectRoot) throw usageError('--project-root only applies together with --scope project.');
    return { scope, root: null, key: 'user', profileId: 'user' };
  }
  const given = projectRoot ? path.resolve(ctx.cwd, projectRoot) : findProjectRoot(ctx.cwd);
  const info = inspect(given);
  if (!info.exists || !info.isDir) throw usageError(`Project root ${given} is not an existing directory.`);
  const root = fs.realpathSync(given);
  let realHome = ctx.home;
  try {
    realHome = fs.realpathSync(ctx.home);
  } catch {
    /* keep */
  }
  if (isWithin(realHome, root, ctx.platform) || isWithin(ctx.home, root, ctx.platform)) {
    throw usageError(`Project root ${root} is your home directory (or above it). Use the default user scope instead, or pass --project-root <repo>.`);
  }
  return { scope, root, key: P.scopeKey('project', root), profileId: P.profileIdFor('project', root, ctx.platform) };
}

const scopeFlags = (sc) => (sc.scope === 'user' ? '' : ` --scope project --project-root "${sc.root}"`);

function resolveTargets(target, det, prev, mode) {
  if (!TARGETS.includes(target)) throw usageError(`--target must be one of ${TARGETS.join(', ')} (got "${target}").`);
  const installed = prev ? Object.keys(prev.targets ?? {}) : [];
  if (mode === 'install') {
    if (target === 'both') return [...CLIENTS];
    if (target !== 'auto') return [target];
    return CLIENTS.filter((c) => det[c].detected || installed.includes(c));
  }
  const want = target === 'auto' || target === 'both' ? installed : installed.filter((c) => c === target);
  return CLIENTS.filter((c) => want.includes(c));
}

function noClientError(ctx, det) {
  const lines = [
    'No supported client detected. Nothing was changed.',
    `  Claude Code: ${evidence(det.claude)} (looked for \`claude\` on PATH and ${det.claude.configDir})`,
    `  Codex:       ${evidence(det.codex)} (looked for \`codex\` on PATH and ${det.codex.configDir})`,
  ];
  return new TlaError('NO_CLIENT', lines.join('\n'), {
    exitCode: EXIT.NOTHING,
    hint: 'Install Claude Code and/or Codex first, or pick a target explicitly:\n  npx -y talk-like-akane@latest install --target claude\n  npx -y talk-like-akane@latest install --target codex\n  npx -y talk-like-akane@latest install --target both',
  });
}

function notInstalled(sc, target) {
  const what = target && target !== 'auto' && target !== 'both' ? `${CLIENT_NAMES[target]} ` : '';
  return new TlaError('NOT_INSTALLED', `talk-like-akane is not installed for ${what}${sc.scope === 'user' ? 'the user scope' : `project ${sc.root}`}.`, {
    exitCode: EXIT.NOTHING,
    hint: `Install it first: npx -y talk-like-akane@latest install${scopeFlags(sc)}`,
  });
}

function runnerSource() {
  return fs.readFileSync(path.join(pkgRoot(), 'src', 'hook-runner.mjs'));
}

function planRuntimeFile(plan, file, content, label) {
  const info = inspect(file);
  if (info.exists && (info.symlink || !info.isFile)) {
    throw conflictError(`${file} is a symlink or directory, so the hook runtime will not be written there. Nothing was changed.`, 'Remove it, then run the command again.');
  }
  plan.put(file, info.exists ? fs.readFileSync(file) : null, content, { label });
}

function planRuntimeRemoval(plan, file, label) {
  const info = inspect(file);
  if (info.exists && info.isFile && !info.symlink) plan.put(file, fs.readFileSync(file), null, { label });
}

export function parseLevel(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || !LEVELS.includes(n) || String(v).trim() === '') throw usageError(`Level must be an integer from 1 to 5 (got "${v}").`);
  return n;
}

/** install | update | set-level | set-language */
export function reconcile(ctx, { mode = 'install', target = 'auto', scope, projectRoot, level, language, dryRun = false } = {}) {
  const sc = resolveScope(ctx, { scope, projectRoot });
  const det = detectClients(ctx);
  const st0 = loadState(ctx);
  const prev0 = st0.data.installs[sc.key];
  if (mode !== 'install' && !prev0) throw notInstalled(sc);
  const targets0 = resolveTargets(target, det, prev0, mode);
  if (targets0.length === 0) throw mode === 'install' ? noClientError(ctx, det) : notInstalled(sc, target);

  const lock = dryRun ? null : acquireLock(ctx);
  try {
    const st = dryRun ? st0 : loadState(ctx);
    const prev = st.data.installs[sc.key];
    const targets = resolveTargets(target, det, prev, mode);
    const version = packageVersion();
    const lvl = level ?? prev?.level ?? DEFAULT_LEVEL;
    const lang = language ?? prev?.language ?? 'auto';
    const nowIso = ctx.now().toISOString();
    const plan = new Plan();
    const runner = P.runnerPath(ctx);
    planRuntimeFile(plan, runner, runnerSource(), 'SessionStart hook runner (persistent copy)');

    const next = {
      scope: sc.scope,
      projectRoot: sc.root,
      profileId: sc.profileId,
      version,
      level: lvl,
      language: lang,
      installedAt: prev?.installedAt ?? nowIso,
      updatedAt: prev?.updatedAt ?? nowIso,
      targets: clone(prev?.targets ?? {}),
    };
    const results = [];
    for (const client of targets) {
      const render = { client, level: lvl, language: lang, version };
      const args = {
        scope: sc.scope,
        root: sc.root,
        profileId: sc.profileId,
        render,
        prev: prev?.targets?.[client],
        hookCommand: buildHookCommand(ctx, runner, client, sc.profileId),
        backupKey: sc.profileId,
        now: nowIso,
      };
      const rec = client === 'claude' ? planClaudeInstall(ctx, plan, args) : planCodexInstall(ctx, plan, args);
      const notes = rec.notes ?? [];
      delete rec.notes;
      planRuntimeFile(plan, P.profilePath(ctx, sc.profileId, client), renderProfile(render, { scope: sc.scope, profileId: sc.profileId, projectRoot: sc.root }), `${CLIENT_NAMES[client]} hook profile`);
      next.targets[client] = rec;
      results.push({ client, notes, detected: det[client], wasInstalled: !!prev?.targets?.[client] });
    }
    const metaChanged = !prev || prev.level !== lvl || prev.language !== lang || prev.version !== version || !deepEqual(prev.targets, next.targets);
    if (plan.changed || metaChanged) next.updatedAt = nowIso;
    const nextState = { ...clone(st.data), schema: STATE_SCHEMA, tool: 'talk-like-akane' };
    nextState.installs[sc.key] = next;
    const parents = [...new Set([...(st.data.dataDirParents ?? []), ...(lock?.createdParents ?? [])])];
    if (parents.length) nextState.dataDirParents = parents;
    if (!deepEqual(nextState, st.data)) plan.put(st.file, st.before, serializeState(nextState), { label: 'talk-like-akane install state', mode: 0o600 });

    const summary = { mode, scope: sc, targets, results, level: lvl, language: lang, version, plan: plan.describe(), changed: plan.changed, install: next };
    if (dryRun) return { ...summary, dryRun: true };
    applyPlan(plan, { faultAfterOps: ctx.faultAfterOps });
    return { ...summary, dryRun: false };
  } finally {
    lock?.release();
  }
}

export function uninstall(ctx, { target = 'auto', scope, projectRoot, dryRun = false } = {}) {
  const sc = resolveScope(ctx, { scope, projectRoot });
  const st0 = loadState(ctx);
  const prev0 = st0.data.installs[sc.key];
  if (!prev0) throw notInstalled(sc);
  if (resolveTargets(target, null, prev0, 'maintenance').length === 0) throw notInstalled(sc, target);

  const lock = dryRun ? null : acquireLock(ctx);
  let removedAll = false;
  let parents = [];
  try {
    const st = dryRun ? st0 : loadState(ctx);
    const prev = st.data.installs[sc.key];
    if (!prev) throw notInstalled(sc);
    parents = st.data.dataDirParents ?? [];
    const targets = resolveTargets(target, null, prev, 'maintenance');
    const plan = new Plan();
    const results = [];
    for (const client of targets) {
      const rec = prev.targets[client];
      const notes = client === 'claude' ? planClaudeRemove(ctx, plan, { rec, profileId: sc.profileId }) : planCodexRemove(ctx, plan, { rec, profileId: sc.profileId });
      planRuntimeRemoval(plan, P.profilePath(ctx, sc.profileId, client), `${CLIENT_NAMES[client]} hook profile`);
      for (const rel of [rec.settings?.backup, rec.agents?.backup, rec.hooks?.backup].filter(Boolean)) {
        planRuntimeRemoval(plan, path.join(P.backupsDir(ctx), rel), 'backup');
      }
      results.push({ client, notes });
    }
    const nextState = clone(st.data);
    const remaining = Object.keys(prev.targets).filter((c) => !targets.includes(c));
    if (remaining.length === 0) delete nextState.installs[sc.key];
    else {
      for (const c of targets) delete nextState.installs[sc.key].targets[c];
      nextState.installs[sc.key].updatedAt = ctx.now().toISOString();
    }
    plan.rmdirIfEmpty(path.join(P.backupsDir(ctx), sc.profileId));
    const fullyRemoved = Object.keys(nextState.installs).length === 0;
    if (fullyRemoved) {
      planRuntimeRemoval(plan, P.runnerPath(ctx), 'SessionStart hook runner');
      plan.put(st.file, st.before, null, { label: 'talk-like-akane install state' });
      for (const d of [P.profilesDir(ctx), P.markersDir(ctx), P.runtimeDir(ctx), P.backupsDir(ctx)]) plan.rmdirIfEmpty(d);
    } else {
      plan.put(st.file, st.before, serializeState(nextState), { label: 'talk-like-akane install state', mode: 0o600 });
    }
    const summary = { mode: 'uninstall', scope: sc, targets, results, plan: plan.describe(), fullyRemoved };
    if (dryRun) return { ...summary, dryRun: true };
    // Run markers are diagnostics written by the hook itself. Remove them best-effort, outside the transaction.
    for (const c of targets) {
      try {
        fs.unlinkSync(P.markerPath(ctx, sc.profileId, c));
      } catch {
        /* absent */
      }
    }
    applyPlan(plan, { faultAfterOps: ctx.faultAfterOps });
    removedAll = fullyRemoved;
    return { ...summary, dryRun: false };
  } finally {
    lock?.release({ removeDirIfEmpty: removedAll, extraDirs: removedAll ? parents : [] });
  }
}
