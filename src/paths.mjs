// Platform-specific locations. Everything takes an explicit ctx so tests never touch the real home.
import path from 'node:path';
import os from 'node:os';
import { TOOL, sha256 } from './util.mjs';

export function getEnv(ctx, name) {
  if (ctx.platform !== 'win32') return ctx.env[name];
  const key = Object.keys(ctx.env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key ? ctx.env[key] : undefined;
}

export function makeContext(overrides = {}) {
  const env = overrides.env ?? process.env;
  const platform = overrides.platform ?? process.platform;
  return {
    env,
    platform,
    home: overrides.home ?? os.homedir(),
    cwd: overrides.cwd ?? process.cwd(),
    execPath: overrides.execPath ?? process.execPath,
    now: overrides.now ?? (() => new Date()),
    out: overrides.out ?? ((s) => process.stdout.write(s)),
    err: overrides.err ?? ((s) => process.stderr.write(s)),
    faultAfterOps: overrides.faultAfterOps,
    managedSettingsPaths: overrides.managedSettingsPaths,
    codexRequirementsPaths: overrides.codexRequirementsPaths,
  };
}

/** Persistent per-user data directory for the hook runtime, state and backups. Never the npx cache. */
export function dataDir(ctx) {
  const override = getEnv(ctx, 'TALK_LIKE_AKANE_HOME');
  if (override) return path.resolve(override);
  if (ctx.platform === 'win32') {
    const local = getEnv(ctx, 'LOCALAPPDATA');
    return path.join(local && path.isAbsolute(local) ? local : path.join(ctx.home, 'AppData', 'Local'), TOOL);
  }
  if (ctx.platform === 'darwin') return path.join(ctx.home, 'Library', 'Application Support', TOOL);
  const xdg = getEnv(ctx, 'XDG_DATA_HOME');
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(ctx.home, '.local', 'share'), TOOL);
}

export const runtimeDir = (ctx) => path.join(dataDir(ctx), 'runtime');
export const runnerPath = (ctx) => path.join(runtimeDir(ctx), 'hook-runner.mjs');
export const profilesDir = (ctx) => path.join(runtimeDir(ctx), 'profiles');
export const markersDir = (ctx) => path.join(runtimeDir(ctx), 'markers');
export const profilePath = (ctx, profileId, client) => path.join(profilesDir(ctx), `${profileId}.${client}.json`);
export const markerPath = (ctx, profileId, client) => path.join(markersDir(ctx), `${profileId}.${client}.json`);
export const statePath = (ctx) => path.join(dataDir(ctx), 'state.json');
export const backupsDir = (ctx) => path.join(dataDir(ctx), 'backups');

export function claudeHome(ctx) {
  const v = getEnv(ctx, 'CLAUDE_CONFIG_DIR');
  return v ? path.resolve(v) : path.join(ctx.home, '.claude');
}

export function codexHome(ctx) {
  const v = getEnv(ctx, 'CODEX_HOME');
  return v ? path.resolve(v) : path.join(ctx.home, '.codex');
}

/** Codex user skills live under $HOME/.agents/skills regardless of CODEX_HOME (per Codex docs). */
export const agentsSkillsHome = (ctx) => path.join(ctx.home, '.agents', 'skills');

export function claudeManagedSettingsPaths(ctx) {
  if (ctx.managedSettingsPaths) return ctx.managedSettingsPaths;
  if (ctx.platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  if (ctx.platform === 'win32') {
    const pf = getEnv(ctx, 'ProgramFiles') || 'C:\\Program Files';
    const pd = getEnv(ctx, 'ProgramData') || 'C:\\ProgramData';
    return [path.join(pf, 'ClaudeCode', 'managed-settings.json'), path.join(pd, 'ClaudeCode', 'managed-settings.json')];
  }
  return ['/etc/claude-code/managed-settings.json'];
}

export function codexRequirementsPaths(ctx) {
  if (ctx.codexRequirementsPaths) return ctx.codexRequirementsPaths;
  if (ctx.platform === 'win32') {
    const pd = getEnv(ctx, 'ProgramData') || 'C:\\ProgramData';
    return [path.join(pd, 'OpenAI', 'Codex', 'requirements.toml')];
  }
  return ['/etc/codex/requirements.toml'];
}

export function scopeKey(scope, root) {
  return scope === 'user' ? 'user' : `project:${root}`;
}

export function profileIdFor(scope, root, platform) {
  if (scope === 'user') return 'user';
  const norm = platform === 'win32' ? root.toLowerCase() : root;
  return `p-${sha256(norm).slice(0, 12)}`;
}
