# Changelog

All notable changes to this project are documented here. Versions follow [SemVer](https://semver.org/), and each release is tagged `vX.Y.Z`.

## 0.1.3 (2026-11-23)

- Includes the 0.1.2 persona change below. 0.1.2 was tagged but never published: its SessionStart reminder exceeded the word budget on Windows. The reminder is now shorter and states that 매도 is Akane's core, even in long reports.

## 0.1.2 (2026-11-23, not published)

- Persona: Korean replies must use spoken 반말 (해체: -야, -해, -지, -네) and never written 해라체 (-다, -한다, -해라). Long or structured answers (findings, status reports, lists) keep the voice, with an in-character opening and at least one jab. A new long-answer direction example covers this. Found in real-model runs where Sonnet 5.5 answered in a neutral 해라체 report voice.

## 0.1.1 (2026-11-20)

- Persona: Akane is now a perfect 2D-style sadistic queen (女王様) who treats the user as her servant (imperious commands, signature laughs, rotating nicknames such as 하인/돼지/下僕/servant). Contempt for sloppy work and excuses is explicit, and level 5 may swear. No softening for tired users. Risky actions still put risks and approvals first, with the tone kept harsh. Playful protests no longer stop the act; turning it off is done with the CLI, and an explicit request still gets a neutral answer. Hard limits remain: accurate facts, no slurs or identity attacks, no sexual content, and the act drops on real crisis signals.
- **Default level is now 5** (was 4). Existing installs keep their saved level; new installs start at 5.
- Persona: one well-aimed jab per reply whose position rotates (opening, aside or word choice), no habitual closing quip, and never toned down at level 4. Found in real-model runs where Codex closed almost every reply the same way. A first, vaguer wording made Claude drop the character, so the rule now states the intensity explicitly.
- Persona: keep the character equally present in every language (English carries it in framing and word choice); two more English direction lines. Found in real-model runs where Codex English turns were nearly neutral.
- `status`: no false "project style shadows Akane" warning when run from the home directory.
- Windows: force LF line endings in the repository (CRLF shebang safety); test fix for the Windows locale fallback.

## 0.1.0 (2026-11-20)

- First implementation of the one-command installer: `npx -y talk-like-akane@latest`.
- Claude Code: `Akane` output style (`keep-coding-instructions: true`), `outputStyle` activation with restore on uninstall, user-level `SessionStart` command hook, management skill.
- Codex: managed block in the effective global AGENTS file (`AGENTS.override.md` aware), `SessionStart` command hook in `hooks.json` (trust is left to the user), management skill in `~/.agents/skills`.
- Persistent, self-contained hook runner in the per-user data directory (never the npx cache). Fail-open, no network, subagent-aware.
- Commands: `install`, `status`, `set-level`, `set-language`, `update`, `uninstall`, `--dry-run`, `--json`, `--scope user|project`.
- Language `auto` by default with any BCP 47 preference; intensity levels 1–5 (default 4).
- Atomic multi-file changes with rollback, ownership tracking, one-time backups and byte-identical restore.
