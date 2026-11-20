// Claude Code adapter: management skill, `Akane` output style, `outputStyle` activation and a SessionStart hook.
import path from 'node:path';
import { claudeHome } from './paths.mjs';
import { renderOutputStyle, renderSkill, STYLE_NAME } from './render.mjs';
import { buildHookGroup, upsertSessionStart, removeSessionStart } from './hooks.mjs';
import { parseJsonConfig, stringifyJson, deepEqual, clone, conflictError } from './util.mjs';
import { readEditableConfig, planOwnedFile, planOwnedRemoval, planBackup, readBackup, missingAncestors, unionDirs } from './managed.mjs';

export function claudeLocations(ctx, scope, root) {
  const base = scope === 'user' ? claudeHome(ctx) : path.join(root, '.claude');
  return {
    base,
    skill: path.join(base, 'skills', 'talk-like-akane', 'SKILL.md'),
    style: path.join(base, 'output-styles', 'akane.md'),
    settings: path.join(base, scope === 'user' ? 'settings.json' : 'settings.local.json'),
  };
}

export function planClaudeInstall(ctx, plan, { scope, root, profileId, render, prev, hookCommand, backupKey, now }) {
  const loc = claudeLocations(ctx, scope, root);
  const createdDirs = unionDirs(prev?.createdDirs, missingAncestors(loc.skill), missingAncestors(loc.style), missingAncestors(loc.settings));
  const files = {
    skill: planOwnedFile(plan, loc.skill, renderSkill(render), prev?.files?.skill, 'Claude Code management skill'),
    style: planOwnedFile(plan, loc.style, renderOutputStyle(render), prev?.files?.style, 'Claude Code output style "Akane"'),
  };

  const cfg = readEditableConfig(loc.settings);
  const { data, fmt } = parseJsonConfig(cfg.before, loc.settings);
  let next = clone(data);
  const p = prev?.settings;
  const settings = { path: loc.settings, createdFile: p ? p.createdFile : !cfg.exists, backup: p?.backup ?? null };

  // outputStyle: remember the value we replace. Keep the original record while it is still ours.
  if (next.outputStyle === STYLE_NAME && p?.outputStyleSet) settings.prevOutputStyle = p.prevOutputStyle;
  else settings.prevOutputStyle = Object.hasOwn(next, 'outputStyle') ? { present: true, value: next.outputStyle } : { present: false };
  settings.outputStyleSet = true;
  next.outputStyle = STYLE_NAME;

  const group = buildHookGroup(hookCommand);
  const r = upsertSessionStart(next, group, { client: 'claude', profileId, recordedGroup: p?.hookGroup, file: loc.settings });
  next = r.data;
  settings.hookGroup = group;
  settings.createdHooksKey = p?.hookGroup ? p.createdHooksKey : r.createdHooksKey;
  settings.createdEventKey = p?.hookGroup ? p.createdEventKey : r.createdEventKey;
  settings.hookIndex = r.index;
  settings.hookRegisteredAt = r.changed || !p?.hookRegisteredAt ? now : p.hookRegisteredAt;

  if (!deepEqual(next, data)) {
    settings.backup = planBackup(ctx, plan, backupKey, cfg, settings.backup, settings.createdFile);
    plan.put(cfg.target, cfg.before, stringifyJson(next, fmt), { label: `Claude Code ${path.basename(loc.settings)} (outputStyle + SessionStart hook)` });
  }
  return { client: 'claude', files, settings, createdDirs, notes: settingsNotes(cfg, settings) };
}

function settingsNotes(cfg, settings) {
  const notes = [];
  if (cfg.symlink) notes.push(`${cfg.file} is a symlink; edited its target ${cfg.target}`);
  const pv = settings.prevOutputStyle;
  if (pv?.present && pv.value !== STYLE_NAME) notes.push(`previous outputStyle "${pv.value}" saved; uninstall restores it`);
  return notes;
}

export function planClaudeRemove(ctx, plan, { rec, profileId }) {
  const notes = [];
  if (rec.files?.skill) planOwnedRemoval(plan, rec.files.skill, 'Claude Code management skill', notes);
  if (rec.files?.style) planOwnedRemoval(plan, rec.files.style, 'Claude Code output style', notes);
  const s = rec.settings;
  if (s) {
    const cfg = readEditableConfig(s.path);
    if (!cfg.exists) {
      notes.push(`${s.path} no longer exists; nothing to restore`);
    } else {
      const { data, fmt } = parseJsonConfig(cfg.before, s.path);
      let next = clone(data);
      if (s.outputStyleSet) {
        if (next.outputStyle === STYLE_NAME) {
          if (s.prevOutputStyle?.present) next.outputStyle = s.prevOutputStyle.value;
          else delete next.outputStyle;
        } else if (Object.hasOwn(next, 'outputStyle')) {
          notes.push(`kept outputStyle "${next.outputStyle}" (you changed it after installing)`);
        }
      }
      if (s.hookGroup) {
        const r = removeSessionStart(next, { client: 'claude', profileId, recordedGroup: s.hookGroup, createdHooksKey: s.createdHooksKey, createdEventKey: s.createdEventKey });
        if (r.edited) throw conflictError(`The talk-like-akane SessionStart entry in ${s.path} was edited after installation. Nothing was changed.`, 'Delete that entry by hand, then run uninstall again.');
        if (!r.removed) notes.push('SessionStart hook entry was already gone');
        next = r.data;
      }
      let after;
      if (deepEqual(next, data)) after = cfg.before;
      else {
        const backup = readBackup(ctx, s.backup);
        let original;
        try {
          original = backup ? parseJsonConfig(backup, s.path).data : undefined;
        } catch {
          original = undefined;
        }
        if (backup && deepEqual(original, next)) after = backup; // byte-identical restore
        else if (s.createdFile && Object.keys(next).length === 0) after = null;
        else after = stringifyJson(next, fmt);
      }
      plan.put(cfg.target, cfg.before, after, { label: `Claude Code ${path.basename(s.path)}` });
    }
  }
  for (const d of rec.createdDirs ?? []) plan.rmdirIfEmpty(d);
  return notes;
}
