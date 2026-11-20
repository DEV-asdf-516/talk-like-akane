// SessionStart hook entries: command construction plus a merge and removal that never touches other hooks.
import { which } from './detect.mjs';
import { conflictError, deepEqual, clone } from './util.mjs';

export const HOOK_TAG = '--managed-by talk-like-akane';
export const SESSION_START_MATCHER = 'startup|resume|clear|compact|fork';
export const HOOK_TIMEOUT_SECONDS = 10;

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Builds the hook command string. It must work in the shells the clients use:
 * POSIX sh/bash on macOS/Linux, and Git Bash, PowerShell or cmd on Windows.
 */
export function buildHookCommand(ctx, runner, client, profileId) {
  const tail = `--client ${client} --profile ${profileId} ${HOOK_TAG}`;
  if (ctx.platform === 'win32') {
    const p = runner.replace(/\\/g, '/');
    if (/["$`%!]/.test(p)) {
      throw conflictError(
        `The data directory path contains characters that are unsafe in hook commands: ${runner}`,
        'Set TALK_LIKE_AKANE_HOME to a simple path (for example C:\\talk-like-akane) and run the command again.',
      );
    }
    // Bare `node`: the Windows Node installer puts node on the system PATH that GUI apps inherit too.
    return `node "${p}" ${tail}`;
  }
  // macOS/Linux: an absolute node path survives GUI launches with a minimal PATH. Prefer the
  // PATH-resolved (stable, symlinked) location over process.execPath (often versioned).
  const node = which('node', ctx) || ctx.execPath;
  return `${shq(node)} ${shq(runner)} ${tail}`;
}

export function buildHookGroup(command) {
  return { matcher: SESSION_START_MATCHER, hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }] };
}

function isOwnHandler(h, client, profileId) {
  return (
    h && typeof h === 'object' && typeof h.command === 'string' && h.command.includes(HOOK_TAG) &&
    h.command.includes(`--client ${client} `) && h.command.includes(`--profile ${profileId} `)
  );
}

export function findOwnGroups(list, client, profileId) {
  const idx = [];
  (Array.isArray(list) ? list : []).forEach((g, i) => {
    if (g && Array.isArray(g.hooks) && g.hooks.some((h) => isOwnHandler(h, client, profileId))) idx.push(i);
  });
  return idx;
}

/**
 * Insert or replace our SessionStart group inside a settings/hooks.json object.
 * Returns { data, index, createdHooksKey, createdEventKey, changed }.
 */
export function upsertSessionStart(data, group, { client, profileId, recordedGroup, file }) {
  const out = clone(data);
  let createdHooksKey = false;
  let createdEventKey = false;
  if (out.hooks === undefined) {
    out.hooks = {};
    createdHooksKey = true;
  } else if (out.hooks === null || typeof out.hooks !== 'object' || Array.isArray(out.hooks)) {
    throw conflictError(`"hooks" in ${file} is not an object. Nothing was changed.`, 'Fix that key by hand, then run the command again.');
  }
  if (out.hooks.SessionStart === undefined) {
    out.hooks.SessionStart = [];
    createdEventKey = true;
  } else if (!Array.isArray(out.hooks.SessionStart)) {
    throw conflictError(`"hooks.SessionStart" in ${file} is not an array. Nothing was changed.`, 'Fix that key by hand, then run the command again.');
  }
  const list = out.hooks.SessionStart;
  const own = findOwnGroups(list, client, profileId);
  if (own.length > 1) {
    throw conflictError(`${file} contains ${own.length} talk-like-akane SessionStart entries for ${client}/${profileId}. Nothing was changed.`, 'Delete the duplicates by hand, keeping at most one, then run the command again.');
  }
  if (own.length === 1) {
    const i = own[0];
    const current = list[i];
    if (deepEqual(current, group)) return { data: out, index: i, createdHooksKey, createdEventKey, changed: false };
    if (recordedGroup && !deepEqual(current, recordedGroup)) {
      throw conflictError(`The talk-like-akane SessionStart entry in ${file} was edited after installation. Nothing was changed.`, 'Undo the edit or delete that entry, then run the command again.');
    }
    if (!recordedGroup) {
      throw conflictError(`${file} already has a talk-like-akane SessionStart entry that this installation did not record. Nothing was changed.`, 'Delete that entry by hand, then run the command again.');
    }
    list[i] = clone(group);
    return { data: out, index: i, createdHooksKey, createdEventKey, changed: true };
  }
  list.push(clone(group));
  return { data: out, index: list.length - 1, createdHooksKey, createdEventKey, changed: true };
}

/** Remove our group. Empty containers we created are dropped too. Returns { data, removed, edited }. */
export function removeSessionStart(data, { client, profileId, recordedGroup, createdHooksKey, createdEventKey }) {
  const out = clone(data);
  const list = out?.hooks?.SessionStart;
  if (!Array.isArray(list)) return { data: out, removed: false, edited: false };
  const own = findOwnGroups(list, client, profileId);
  if (own.length === 0) return { data: out, removed: false, edited: false };
  const edited = own.some((i) => recordedGroup && !deepEqual(list[i], recordedGroup));
  if (edited) return { data: out, removed: false, edited: true };
  for (const i of own.reverse()) list.splice(i, 1);
  if (list.length === 0 && createdEventKey) delete out.hooks.SessionStart;
  if (createdHooksKey && out.hooks && Object.keys(out.hooks).length === 0) delete out.hooks;
  return { data: out, removed: true, edited: false };
}
