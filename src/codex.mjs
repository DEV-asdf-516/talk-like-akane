// Codex adapter: one managed block in the effective AGENTS file, a management skill, and a SessionStart hook.
import fs from 'node:fs';
import path from 'node:path';
import { codexHome, agentsSkillsHome } from './paths.mjs';
import { renderAgentsBlock, renderSkill, BLOCK_START, BLOCK_END } from './render.mjs';
import { buildHookGroup, upsertSessionStart, removeSessionStart } from './hooks.mjs';
import { parseJsonConfig, stringifyJson, deepEqual, clone, conflictError, sha256, detectTextFormat, inspect } from './util.mjs';
import { readEditableConfig, planOwnedFile, planOwnedRemoval, planBackup, readBackup, missingAncestors, unionDirs } from './managed.mjs';

export function codexLocations(ctx, scope, root) {
  if (scope === 'user') {
    const home = codexHome(ctx);
    return { agentsDir: home, hooks: path.join(home, 'hooks.json'), skill: path.join(agentsSkillsHome(ctx), 'talk-like-akane', 'SKILL.md'), config: path.join(home, 'config.toml') };
  }
  return {
    agentsDir: root,
    hooks: path.join(root, '.codex', 'hooks.json'),
    skill: path.join(root, '.agents', 'skills', 'talk-like-akane', 'SKILL.md'),
    config: path.join(codexHome(ctx), 'config.toml'),
  };
}

function readFollow(file) {
  const info = inspect(file);
  if (!info.exists || info.dangling || !info.isFile) return null;
  return fs.readFileSync(info.realPath);
}

/** Codex reads AGENTS.override.md when it is present and non-empty, otherwise AGENTS.md. */
export function effectiveAgentsFile(dir) {
  const override = path.join(dir, 'AGENTS.override.md');
  const main = path.join(dir, 'AGENTS.md');
  const ov = readFollow(override);
  if (ov && ov.toString('utf8').replace(/^﻿/, '').trim() !== '') return { file: override, kind: 'AGENTS.override.md', other: main };
  return { file: main, kind: 'AGENTS.md', other: override };
}

function indicesOf(text, needle) {
  const out = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) out.push(i);
  return out;
}

export function findBlock(text) {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  const offset = text.length - body.length;
  const s = indicesOf(body, BLOCK_START);
  const e = indicesOf(body, BLOCK_END);
  if (s.length === 0 && e.length === 0) return { state: 'absent' };
  if (s.length === 1 && e.length === 1 && s[0] < e[0]) {
    const start = offset + s[0];
    const end = offset + e[0] + BLOCK_END.length;
    return { state: 'present', start, end, region: text.slice(start, end) };
  }
  return { state: 'corrupt', starts: s.length, ends: e.length };
}

/** Insert or replace the managed block. Content outside the block stays byte-for-byte identical. */
export function upsertBlock(text, renderBlock, prevRec, file) {
  const eol = detectTextFormat(text).eol;
  const block = renderBlock(eol);
  const found = findBlock(text);
  if (found.state === 'corrupt') {
    throw conflictError(`${file} has damaged or duplicate talk-like-akane markers (${found.starts} start, ${found.ends} end). Nothing was changed.`, `Fix the file so it has exactly one ${BLOCK_START} ... ${BLOCK_END} pair (or none), then run the command again.`);
  }
  if (found.state === 'present') {
    if (found.region === block) return { text, sep: prevRec?.sep ?? '', trailing: prevRec?.trailing ?? eol, blockSha256: sha256(block), changed: false };
    if (!prevRec || sha256(found.region) !== prevRec.blockSha256) {
      throw conflictError(
        prevRec ? `The talk-like-akane block in ${file} was edited by hand. Nothing was changed.` : `${file} already contains a talk-like-akane block that this installation did not record. Nothing was changed.`,
        'Remove the block (from the start marker through the end marker) or undo the edit, then run the command again.',
      );
    }
    return { text: text.slice(0, found.start) + block + text.slice(found.end), sep: prevRec.sep, trailing: prevRec.trailing, blockSha256: sha256(block), changed: true };
  }
  const hasBom = text.startsWith('﻿');
  const body = hasBom ? text.slice(1) : text;
  let sep = '';
  if (body.length > 0) {
    if (/\n[ \t]*\r?\n$/.test(body)) sep = '';
    else if (body.endsWith('\n')) sep = eol;
    else sep = eol + eol;
  }
  return { text: text + sep + block + eol, sep, trailing: eol, blockSha256: sha256(block), changed: true };
}

export function removeBlock(text, rec) {
  const found = findBlock(text);
  if (found.state === 'absent') return { text, status: 'missing' };
  if (found.state === 'corrupt') return { text, status: 'corrupt' };
  if (sha256(found.region) !== rec.blockSha256) return { text, status: 'edited' };
  let s = found.start;
  let e = found.end;
  if (rec.trailing && text.startsWith(rec.trailing, e)) e += rec.trailing.length;
  if (rec.sep && text.slice(0, s).endsWith(rec.sep)) s -= rec.sep.length;
  return { text: text.slice(0, s) + text.slice(e), status: 'removed' };
}

export function planCodexInstall(ctx, plan, { scope, root, profileId, render, prev, hookCommand, backupKey, now }) {
  const loc = codexLocations(ctx, scope, root);
  const eff = effectiveAgentsFile(loc.agentsDir);
  const createdDirs = unionDirs(prev?.createdDirs, missingAncestors(loc.skill), missingAncestors(eff.file), missingAncestors(loc.hooks));
  const files = { skill: planOwnedFile(plan, loc.skill, renderSkill(render), prev?.files?.skill, 'Codex management skill') };
  const notes = [];

  // AGENTS block. If the effective file changed since the last run (for example an override appeared), move the block.
  const pa = prev?.agents;
  if (pa && pa.path !== eff.file) {
    const old = readEditableConfig(pa.path);
    if (old.exists) {
      const r = removeBlock(old.before.toString('utf8'), pa);
      if (r.status === 'edited' || r.status === 'corrupt') throw conflictError(`The talk-like-akane block in ${pa.path} was edited or damaged. Nothing was changed.`, 'Remove that block by hand, then run the command again.');
      if (r.status === 'removed') {
        const after = pa.createdFile && r.text.replace(/^﻿/, '').trim() === '' ? null : r.text;
        plan.put(old.target, old.before, after, { label: `Codex ${path.basename(pa.path)} (block moved)` });
      }
    }
    notes.push(`moved the Akane block from ${path.basename(pa.path)} to ${eff.kind}, which Codex actually reads`);
  }
  const keepPrev = pa && pa.path === eff.file ? pa : null;
  const cfg = readEditableConfig(eff.file);
  const text = cfg.before ? cfg.before.toString('utf8') : '';
  const up = upsertBlock(text, (eol) => renderAgentsBlock(render, eol), keepPrev, eff.file);
  const agents = {
    path: eff.file,
    kind: eff.kind,
    blockSha256: up.blockSha256,
    sep: up.sep,
    trailing: up.trailing,
    createdFile: keepPrev ? keepPrev.createdFile : !cfg.exists,
    backup: keepPrev?.backup ?? null,
  };
  if (up.changed) {
    agents.backup = planBackup(ctx, plan, backupKey, cfg, agents.backup, agents.createdFile);
    plan.put(cfg.target, cfg.before, up.text, { label: `Codex ${eff.kind} (Akane block)` });
  }
  if (cfg.symlink) notes.push(`${eff.file} is a symlink; edited its target ${cfg.target}`);

  // hooks.json
  const hcfg = readEditableConfig(loc.hooks);
  const { data, fmt } = parseJsonConfig(hcfg.before, loc.hooks);
  const ph = prev?.hooks;
  const group = buildHookGroup(hookCommand);
  const r = upsertSessionStart(data, group, { client: 'codex', profileId, recordedGroup: ph?.hookGroup, file: loc.hooks });
  const hooks = {
    path: loc.hooks,
    hookGroup: group,
    hookIndex: r.index,
    createdFile: ph ? ph.createdFile : !hcfg.exists,
    createdHooksKey: ph ? ph.createdHooksKey : r.createdHooksKey,
    createdEventKey: ph ? ph.createdEventKey : r.createdEventKey,
    hookRegisteredAt: r.changed || !ph?.hookRegisteredAt ? now : ph.hookRegisteredAt,
    backup: ph?.backup ?? null,
  };
  if (!deepEqual(r.data, data) || !hcfg.exists) {
    hooks.backup = planBackup(ctx, plan, backupKey, hcfg, hooks.backup, hooks.createdFile);
    plan.put(hcfg.target, hcfg.before, stringifyJson(r.data, fmt), { label: 'Codex hooks.json (SessionStart hook)' });
  }
  if (hcfg.symlink) notes.push(`${loc.hooks} is a symlink; edited its target ${hcfg.target}`);
  return { client: 'codex', files, agents, hooks, createdDirs, notes };
}

export function planCodexRemove(ctx, plan, { rec, profileId }) {
  const notes = [];
  if (rec.files?.skill) planOwnedRemoval(plan, rec.files.skill, 'Codex management skill', notes);
  const a = rec.agents;
  if (a) {
    const cfg = readEditableConfig(a.path);
    if (!cfg.exists) notes.push(`${a.path} no longer exists`);
    else {
      const text = cfg.before.toString('utf8');
      const r = removeBlock(text, a);
      if (r.status === 'edited') throw conflictError(`The talk-like-akane block in ${a.path} was edited by hand, so it will not be removed silently. Nothing was changed.`, 'Delete the block yourself (start marker through end marker), then run uninstall again.');
      if (r.status === 'corrupt') throw conflictError(`${a.path} has damaged or duplicate talk-like-akane markers. Nothing was changed.`, 'Fix the markers by hand, then run uninstall again.');
      if (r.status === 'missing') notes.push(`Akane block already gone from ${a.path}`);
      else {
        const backup = readBackup(ctx, a.backup);
        let after = r.text;
        if (backup && backup.toString('utf8') === r.text) after = backup;
        else if (a.createdFile && r.text.replace(/^﻿/, '').trim() === '') after = null;
        plan.put(cfg.target, cfg.before, after, { label: `Codex ${path.basename(a.path)}` });
      }
    }
  }
  const h = rec.hooks;
  if (h) {
    const cfg = readEditableConfig(h.path);
    if (!cfg.exists) notes.push(`${h.path} no longer exists`);
    else {
      const { data, fmt } = parseJsonConfig(cfg.before, h.path);
      const r = removeSessionStart(data, { client: 'codex', profileId, recordedGroup: h.hookGroup, createdHooksKey: h.createdHooksKey, createdEventKey: h.createdEventKey });
      if (r.edited) throw conflictError(`The talk-like-akane SessionStart entry in ${h.path} was edited after installation. Nothing was changed.`, 'Delete that entry by hand, then run uninstall again.');
      if (!r.removed) notes.push('SessionStart hook entry was already gone');
      let after;
      if (deepEqual(r.data, data)) after = cfg.before;
      else {
        const backup = readBackup(ctx, h.backup);
        let original;
        try {
          original = backup ? parseJsonConfig(backup, h.path).data : undefined;
        } catch {
          original = undefined;
        }
        if (backup && deepEqual(original, r.data)) after = backup;
        else if (h.createdFile && Object.keys(r.data).length === 0) after = null;
        else after = stringifyJson(r.data, fmt);
      }
      plan.put(cfg.target, cfg.before, after, { label: 'Codex hooks.json' });
    }
  }
  for (const d of rec.createdDirs ?? []) plan.rmdirIfEmpty(d);
  return notes;
}
