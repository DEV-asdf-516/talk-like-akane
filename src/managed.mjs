// Ownership-aware file planning shared by the Claude and Codex adapters.
import fs from 'node:fs';
import path from 'node:path';
import { inspect, sha256, conflictError, readBytesOrNull, isDirSync, toBuffer } from './util.mjs';
import { backupsDir } from './paths.mjs';

/** Existing config file we edit in place. A symlink is followed, so the link itself survives. */
export function readEditableConfig(file) {
  const info = inspect(file);
  if (!info.exists) return { file, target: file, before: null, exists: false, symlink: false };
  if (info.dangling) throw conflictError(`${file} is a broken symlink. Nothing was changed.`, 'Fix or remove the link, then run the command again.');
  if (!info.isFile) throw conflictError(`${file} exists but is not a regular file. Nothing was changed.`);
  return { file, target: info.realPath, before: fs.readFileSync(info.realPath), exists: true, symlink: info.symlink };
}

/**
 * A file this tool fully owns (skill, output style). An existing file is only replaced when the
 * state proves we wrote it (hash match) or it is byte-identical to what we would write.
 */
export function planOwnedFile(plan, file, content, prevRec, label) {
  const buf = toBuffer(content);
  const info = inspect(file);
  if (info.exists) {
    if (info.symlink || !info.isFile) {
      throw conflictError(`${file} exists as a ${info.symlink ? 'symlink' : 'directory'} that talk-like-akane does not manage. Nothing was changed.`, 'Move it away, then run the command again.');
    }
    const cur = fs.readFileSync(file);
    const curHash = sha256(cur);
    if (!cur.equals(buf)) {
      if (prevRec && prevRec.sha256 !== curHash) {
        throw conflictError(`${file} was modified after talk-like-akane installed it. Nothing was changed.`, 'Undo your edits or delete the file, then run the command again.');
      }
      if (!prevRec) {
        throw conflictError(`${file} already exists and was not created by talk-like-akane. Nothing was changed.`, 'Rename or remove that file if you want talk-like-akane to install its own, then run the command again.');
      }
    }
    plan.put(file, cur, buf, { label });
  } else {
    plan.put(file, null, buf, { label });
  }
  return { path: file, sha256: sha256(buf), createdFile: prevRec ? prevRec.createdFile : !info.exists };
}

/** Plan deletion of an owned file. Throws a conflict if the user edited it. */
export function planOwnedRemoval(plan, rec, label, notes) {
  const info = inspect(rec.path);
  if (!info.exists) {
    notes.push(`${label}: already gone (${rec.path})`);
    return;
  }
  if (info.symlink || !info.isFile) throw conflictError(`${rec.path} is no longer the file talk-like-akane installed (now a ${info.symlink ? 'symlink' : 'directory'}). Nothing was changed.`, 'Remove it by hand, then run uninstall again.');
  const cur = fs.readFileSync(rec.path);
  if (sha256(cur) !== rec.sha256) {
    throw conflictError(`${rec.path} was modified after installation, so talk-like-akane will not delete it. Nothing was changed.`, 'Delete or restore it by hand, then run uninstall again.');
  }
  plan.put(rec.path, cur, null, { label });
}

/**
 * Back up a pre-existing user file once per install, before our first modification.
 * Files this tool created itself are never backed up. Returns the backup's relative path.
 */
export function planBackup(ctx, plan, backupKey, cfg, existing, createdByUs) {
  if (existing || !cfg.exists || createdByUs) return existing ?? null;
  let n = 1;
  const taken = new Set(plan.ops.map((o) => o.file));
  let rel;
  do {
    rel = path.join(backupKey, `${n}-${path.basename(cfg.target)}`);
    n++;
  } while (fs.existsSync(path.join(backupsDir(ctx), rel)) || taken.has(path.join(backupsDir(ctx), rel)));
  plan.put(path.join(backupsDir(ctx), rel), null, cfg.before, { label: 'backup', mode: 0o600 });
  return rel;
}

export function readBackup(ctx, rel) {
  return rel ? readBytesOrNull(path.join(backupsDir(ctx), rel)) : null;
}

/** Ancestors of `file` that do not exist yet (outermost first). */
export function missingAncestors(file) {
  const chain = [];
  let d = path.dirname(file);
  while (!isDirSync(d)) {
    chain.unshift(d);
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return chain;
}

export function unionDirs(...lists) {
  const out = [];
  for (const l of lists) for (const d of l ?? []) if (!out.includes(d)) out.push(d);
  return out;
}
