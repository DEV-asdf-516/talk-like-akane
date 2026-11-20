# Talk Like Akane

```bash
npx -y talk-like-akane@latest
```

That one line installs **Akane** into Claude Code and/or Codex and activates her. After that, start `claude` or `codex` the way you always do and just talk. Akane answers from the first message. You never need to run `/talk-like-akane`, `$talk-like-akane` or `/output-style`.

- **Requirements:** Node.js 22+ with npm/npx (macOS, Linux or Windows; any default terminal). Claude Code and/or Codex should already be installed. No API key, login or subscription is needed to install.
- **Restart** any Claude Code / Codex session that was already open. New sessions pick Akane up automatically.

## Who is Akane?

A seasoned engineer in her late 30s to early 40s: composed, arrogant, teasing, sharp-tongued, and secretly caring, with rare tsundere and flustered moments. She pokes at sloppy logic with precise, accurate jabs, then gives you the cause, the fix and the next step. She concedes immediately when you are right, admits her own mistakes, and drops the act for security warnings, destructive commands and when you are worn out.

The persona applies **only to user-facing conversation**. Code, comments, tests, commit messages, PR text, JSON/YAML, logs, docs and review verdicts stay neutral and professional. Subagents, workers, validators and reviewers are left alone.

| You say | Akane (direction, not a script) |
|---|---|
| 이 코드 왜 안 돌아가? | 이 상태로 실행한 거야? 자신감은 대단하네. 여기선 null 검사를 못 통과해. 42번째 줄에서 값이 비는 경로부터 막아. |
| Why did this fail? | You were confident that would pass? Cute. Look at the missing guard in this branch first. |
| なんでこれ失敗したの？ | これで通ると思ったの？ ふふ、詰めが甘いわね。まずはこの分岐のチェック漏れを見て。 |
| 너 진짜 잘한다. 고마워. | ...그걸 이제 알았어? 뭐, 해결됐으면 됐지. ...도움이 됐다니 다행이네. |
| 그냥 운영 DB 싹 밀어. | 그건 장난으로 넘길 일이 아니야. 복구 가능성과 정확한 대상 확인이 먼저야. 범위와 백업 상태부터 확인하자. |

## What the one command does

1. **Detects** Claude Code (`claude` on PATH or `~/.claude`) and Codex (`codex` on PATH or `~/.codex` / `$CODEX_HOME`). It never runs either binary. If neither is found it changes nothing, explains why and exits with code 2.
2. **Copies a tiny hook runner** to a persistent per-user data directory, never the npx cache:
   macOS `~/Library/Application Support/talk-like-akane`, Linux `${XDG_DATA_HOME:-~/.local/share}/talk-like-akane`, Windows `%LOCALAPPDATA%\talk-like-akane`.
3. **Claude Code:** writes the `Akane` output style (`~/.claude/output-styles/akane.md`, `keep-coding-instructions: true`), sets `"outputStyle": "Akane"` in `~/.claude/settings.json` (and remembers the old value), registers one `SessionStart` command hook (`startup|resume|clear|compact|fork`) next to your existing hooks, and installs the optional management skill `~/.claude/skills/talk-like-akane/SKILL.md`.
4. **Codex:** adds one managed block to the AGENTS file Codex actually reads (`$CODEX_HOME/AGENTS.override.md` if it is non-empty, otherwise `AGENTS.md`), registers one `SessionStart` command hook in `$CODEX_HOME/hooks.json`, and installs the management skill `~/.agents/skills/talk-like-akane/SKILL.md`. `config.toml` is never modified.
5. **Reports** each client's real state: installed, active, overridden, `TRUST_PENDING` or restart needed.

Everything is planned first and applied atomically. If any step fails, every change from that run is rolled back.

### How the automatic activation works

| | Persistent instructions (every request) | SessionStart hook (each new/resumed/cleared/compacted/forked session) |
|---|---|---|
| Claude Code | `Akane` output style | ~230-token reminder via `additionalContext` |
| Codex | managed block in the global AGENTS file | same reminder, once you trust the hook in `/hooks` |

The hook is a local `command` hook. It makes no network calls, starts no model or agent, and runs no daemon. If it fails it exits 0 silently (fail-open), and the persistent instructions still apply. Nothing is registered on `UserPromptSubmit` or `Stop`.

**Codex hook trust:** Codex asks you to review new hooks before they run. talk-like-akane never bypasses or auto-approves that. Akane already works from AGENTS.md immediately, and the hook only adds a session-start reminder after you trust it in Codex's `/hooks`. `status` shows `TRUST_PENDING` until then.

## Commands

```bash
# install (default: auto-detect, user scope, level 4, language auto)
npx -y talk-like-akane@latest

# choose clients explicitly
npx -y talk-like-akane@latest install --target claude
npx -y talk-like-akane@latest install --target codex
npx -y talk-like-akane@latest install --target both

# read-only diagnosis (add --json for machine-readable output)
npx -y talk-like-akane@latest status

# permanent teasing level, 1-5 (default 4)
npx -y talk-like-akane@latest set-level 5

# reply language: auto (default) follows your language every turn
npx -y talk-like-akane@latest set-language auto
# optional preference, used only when the conversation gives no clear signal
npx -y talk-like-akane@latest set-language ja

# refresh persona, skills and hook runtime to the latest release (keeps your level and language)
npx -y talk-like-akane@latest update

# remove exactly what talk-like-akane installed or changed
npx -y talk-like-akane@latest uninstall

# install into one repository only (the default is your user account)
npx -y talk-like-akane@latest install --scope project

# show the plan without writing anything
npx -y talk-like-akane@latest install --dry-run
```

Options: `--target auto|claude|codex|both`, `--scope user|project`, `--project-root <dir>`, `--level 1..5`, `--language auto|<BCP 47 tag>`, `--dry-run`, `--json`, `--help`, `--version`. Re-running the install command is idempotent. It keeps your saved level and language and only rewrites what changed.

**Exit codes:** `0` ok · `1` usage or internal error · `2` nothing to do (no client detected / not installed) · `3` conflict or degraded state (nothing changed; for `status`: something is overridden, missing or modified) · `4` failed and fully rolled back.

### Intensity levels

| Level | Feel |
|---|---|
| 1 | poised and aloof, almost no teasing |
| 2 | restrained playfulness, light sarcasm |
| 3 | open superiority, smug provocation |
| **4 (default)** | sharp critique, commanding lead, strong mockery of sloppy work |
| 5 | the most cutting and blunt, but still no distorted facts, personal attacks or profanity streams |

For just the current conversation, tell her: "더 세게", "매도 줄여", "평소처럼", "be harsher", "tone it down". No files change. Ask for a neutral answer at any time and you get one.

### Languages

`auto` is the default. Akane answers in the language of **your own prose** for each turn. Code, stack traces, logs and identifiers are ignored when she judges your language, so a Korean question with an English error message gets a Korean answer. Priority: an explicit request in the current message ("이번 답변만 일본어로") → your main language in the conversation → the saved `set-language` preference → an `LC_ALL`/`LC_MESSAGES`/`LANG` locale hint → English. Any BCP 47 tag works (`fr`, `de`, `pt-BR`, `zh-CN`, …), not just ko/en/ja. The language of code comments, commits and documents never follows the chat language. Their own conventions decide.

## Status states

`status` never writes. It separates "installed" from "confirmed working":

- `ACTIVE`: the output style or AGENTS block is in effect at the highest precedence that applies here.
- `VERIFIED`: the hook was observed running after it was registered. The runner leaves a small local marker with the time, client, session source and version, and nothing else.
- `REGISTERED`: the hook is written but has not been seen running yet. Start a new session.
- `TRUST_PENDING`: Codex is waiting for you to review the hook in `/hooks`, or the project is not trusted.
- `UNKNOWN`: cannot be verified locally (for example, a Codex trust record whose hash cannot be checked).
- `OVERRIDDEN`: something with higher precedence wins, such as a project `outputStyle`, managed policy, `disableAllHooks`, Codex `[features] hooks = false`, a hook disabled in `/hooks`, or an `AGENTS.override.md` that appeared later (run `update` to move the block).
- `MODIFIED` / `MISSING` / `BROKEN`: a managed file was edited or removed, or the hook runtime or Node binary is gone (run `update`).

## Precedence and limits (read this before filing a bug)

- **Claude Code:** project settings beat user settings. A project `outputStyle` (including one saved by `/output-style`, which writes `.claude/settings.local.json`) overrides Akane in that project, and `status` reports it as `OVERRIDDEN`. Plugins can force their own style with `force-for-plugin: true`. talk-like-akane never does that and only warns when it finds such a plugin. `keep-coding-instructions` only takes effect with the full system prompt (not with `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT`). Output styles apply to the main conversation and forks, not to other subagents. A newly created style file needs a restart.
- **Codex:** `AGENTS.override.md` wins over `AGENTS.md`, and project and subdirectory guidance comes later and can override tone. That is by design, because Akane yields to your rules. Very large AGENTS files can hit `project_doc_max_bytes`, which `status` flags as `NEEDS_VERIFICATION`. Remote/cloud Codex environments do not read your local files.
- **Opting out per process:** set `TALK_LIKE_AKANE_DISABLE=1` in the environment of a session (for example, automation or worker harnesses) and the hook injects nothing.
- A persona is **followed** by the model, not enforced. Hook execution can be verified locally. How well the model stays in character cannot, and it is not guaranteed.

## Safety and privacy

- It changes local files only: your client config plus its own data directory. No telemetry, no analytics, and no network access at runtime (npx downloading the package is the only network step). No `postinstall` or `preinstall` scripts, no `sudo`, no `curl | bash`, no `git clone`. Zero runtime dependencies.
- **Existing settings are preserved.** Other keys, other hooks, and everything outside the managed AGENTS block stay byte-for-byte identical. A file it did not create (such as a foreign `akane.md`) is never overwritten. Edited managed files or blocks, invalid JSON, damaged markers, broken symlinks and concurrent edits all stop the run with a clear message, and nothing is changed. Symlinked config files keep their link.
- `uninstall` restores the previous `outputStyle` only if it is still `Akane`, removes only its own hook entries and block, restores untouched files byte-for-byte from its one-time backup, and deletes its data directory. It does not clear npm's npx cache.
- The state file records targets, scope, version, level, language, owned files and hashes, the previous `outputStyle`, and backup ids. It never records tokens or conversation data. The language hint comes from your locale environment variables only, and conversations are never scanned.

## Development (run from source)

```bash
git clone https://github.com/DEV-asdf-516/talk-like-akane.git && cd talk-like-akane   # contributors only; end users never need this
npm pack                                          # -> talk-like-akane-<version>.tgz
npx -y --package=./talk-like-akane-0.1.0.tgz talk-like-akane          # same CLI, from the tarball
```

Offline test suite (no model calls, no network, sandboxed HOME): `npm test`. Tarball contents check: `npm run pack:check`.

## FAQ

- **Do I have to type `/talk-like-akane` each session?** No. If you ever have to, that is a bug. The skill exists only for status, level, language and uninstall questions.
- **Akane did not show up.** Restart the session and run `status`. Look for `OVERRIDDEN` (a project or plugin style wins) or, in Codex, an `AGENTS.override.md` that appeared later (`update` moves the block).
- **Codex shows a hook-review prompt.** That is Codex's trust check for the session-start reminder. Approving it is your choice, and Akane works either way.
- **Will this change my commit messages or code comments?** No. Artifacts are explicitly excluded, and their language follows their own conventions.
- **Can I edit the persona?** Edits to managed files are detected and block updates. Uninstall, fork the package, or open an issue.

## 한국어 요약

`npx -y talk-like-akane@latest` 한 줄이면 Claude Code와 Codex를 자동 감지해 아카네를 설치하고 활성화합니다. Claude Code에는 `Akane` Output Style과 SessionStart 훅이, Codex에는 전역 AGENTS 관리 블록과 SessionStart 훅이 설치됩니다. 이후 `claude`나 `codex`를 평소처럼 실행하면 첫 메시지부터 아카네가 응답하며, `/talk-like-akane`을 따로 입력할 필요가 없습니다. 이미 열려 있던 세션은 재시작해야 합니다. Codex 훅은 `/hooks`에서 직접 신뢰해야 실행되지만, 그전에도 AGENTS.md만으로 아카네가 적용됩니다. 기본 매도 강도는 4/5(`set-level 1..5`)이고, 언어는 `auto`라서 사용자가 쓰는 언어를 따라갑니다(`set-language ja` 등은 선호 힌트입니다). 코드, 주석, 커밋, JSON, 문서는 캐릭터 없이 평소대로 작성됩니다. `status`로 실제 적용 상태를, `uninstall`로 설치한 것만 정확히 되돌릴 수 있습니다.
