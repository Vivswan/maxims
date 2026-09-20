---
order: 60
group: Reference
---

# Harnesses

Eight coding agents ship in the first release, and each one gets a rule file in its always-loaded layer plus one session-start hook that runs `npx -y @vivswan/maxims sync --quiet`. This matrix is rendered by hand until it is generated from the harness definitions in the code, so a path here is the specification the code must satisfy.

## The matrix

Ids in the first column are what `--agent` accepts. A project target is written for a project install, a global target for `-g`; a harness with no global target [skips `-g`](cli.md#flags).

| id | harness | project target | global target | strategy | hook | tier |
| --- | --- | --- | --- | --- | --- | --- |
| `claude-code` | Claude Code | `.claude/rules/maxims-<source>.md` | `~/.claude/rules/maxims-<source>.md` | A | `SessionStart` entry in `.claude/settings.json` or `~/.claude/settings.json`, async | 1 |
| `codex` | Codex CLI | `AGENTS.md` block | `~/.codex/AGENTS.md` block | B | `SessionStart` entry in `.codex/hooks.json` or `~/.codex/hooks.json`, async | 1, or 2 when `hooks = false` |
| `gemini-cli` | Gemini CLI | `GEMINI.md` block | `~/.gemini/GEMINI.md` block | B | `SessionStart` entry in `.gemini/settings.json` or `~/.gemini/settings.json` | 1 |
| `copilot` | GitHub Copilot | `.github/instructions/maxims-<source>.instructions.md` | `~/.copilot/instructions/maxims-<source>.instructions.md` | A | `sessionStart` entry in a maxims-owned file under `.github/hooks` or `~/.copilot/hooks` | 1 for the CLI, 2 for the IDE |
| `cursor` | Cursor | `.cursor/rules/maxims-<source>.mdc` | none; user rules are UI-stored | A | `sessionStart` entry in `.cursor/hooks.json` | 1, project only |
| `cline` | Cline | `.clinerules/maxims-<source>.md` | `~/Documents/Cline/Rules/maxims-<source>.md` | A | executable `.clinerules/hooks/TaskStart` or `~/Documents/Cline/Hooks/TaskStart` | 1 |
| `opencode` | OpenCode | `.opencode/memories/maxims-<source>.md`, listed in `opencode.json` | `~/.config/opencode/AGENTS.md` block | A for the project, B for global | plugin file in `.opencode/plugins/` or `~/.config/opencode/plugins/`, run on `session.created` | 1 |
| `dsh` | DeepSeek Harness | `AGENTS.md` block | `~/.dsh/AGENTS.md` block | B | `dsh-hooks-claude-code` bridge entry in `cordis.yml`, pointing at a maxims-owned `.dsh/maxims-hooks.json` | 1, with caveats |

Strategy A writes one whole file per source into a rules directory, so removal is a file delete. Strategy B writes a managed block into a shared instructions file the user also owns, so removal cuts the block and keeps the rest.

Memory bodies do not vary by harness. They live in the maxims store and rule lines point at them; a project install links them into `.agents/memories/` for every harness, the convention `npx skills` set with `.agents/skills/`.

Pi, Windsurf, Amp, Warp, and Zed have designed rows but do not ship: Pi's freshness needs a maxims extension package, Windsurf would reuse the same hook writer, and Amp, Warp, and Zed have no hook system, so they would rely on the tier 2 mechanisms below.

## Tiers

| tier | meaning | freshness |
| --- | --- | --- |
| 1 | a rule file plus a session-start hook | loads every session and refreshes itself |
| 2 | a rule file, no hook | kept fresh by any hooked harness on the same machine (below), manual otherwise |
| 3 | unsupported | no file-based always-loaded layer exists, so there is nowhere to put a guarantee; web-only agents with UI-stored rules |

The tier a harness achieves is a sync-time result that `list` reports. It is not stored, so a config edit that demotes a harness is visible the next time you look.

## One hook refreshes every harness

`maxims sync` applies state for every harness on the machine, not only the one whose hook invoked it. Any one tier 1 hook therefore refreshes every tier 2 target as a side effect, and the tenth source costs no tenth hook.

Tier 2 therefore means fresh as long as some hooked harness gets used on this machine. A tier 2 harness is stale only on a machine with zero tier 1 harnesses, and every shipped harness has a tier 1 mechanism. Copilot's IDE half has no hook at all, and Codex with hooks switched off or Cline without hooks enabled also land at tier 2; the catches below name each prerequisite.

A shell-rc line, an OS scheduler, an editor folder-open task, and a git hook were each considered as a fallback for that machine and rejected. Each forks per platform or writes into shared territory for a benefit the property above already delivers. The [design decisions](design-decisions.md) page records them.

## The staleness notice and the self-refresh line

A source is stale once its last successful fetch is more than 7 days old, or immediately when the repo returns 404. The notice names the reason (network, rate limit, missing) rather than just "stale".

| where the harness has | the notice goes to |
| --- | --- |
| a hook | the hook's stdout, which the harness adds to the agent's context on exit 0, so no non-zero exit and no hook error banner |
| no hook (tier 2) | one managed line at the top of the maxims block in the rule file, removed on the next successful refresh |

Beneath that line, and only there, maxims writes the self-refresh line: if the staleness notice is present, run `npx -y @vivswan/maxims sync --quiet` before continuing. It is a rule asking an agent to act, so it is best-effort even from the always-loaded layer, and some harnesses gate shell commands behind approval.

On tier 1 harnesses the self-refresh line is not written, because the hook already guarantees freshness and the line would be wasted context.

Neither the notice line nor the self-refresh line counts against the [rule cap](cli.md#the-cap-and-the-cooldown); the cap governs how many of a source's memories reach the file, not what maxims says about its own state.

## The rule file

Generated on every sync, compared to what is on disk, and written only on a difference. Hand edits inside the block are overwritten by design; `--dry-run` shows what would be lost, and the marker text says where the real edit belongs.

```markdown
<!-- maxims:begin @Vivswan/skills sha=fc67557 -->
- Codex rubber-duck review before EVERY commit, however trivial. (detail: ~/.agents/maxims/store/vivswan/skills/rubber-duck-before-every-commit.md)
<!-- maxims:end @Vivswan/skills -->
```

| rule | reason |
| --- | --- |
| the rule file is a real file on every harness, never a symlink | Claude Code skips a symlinked rule file pointing outside the working directory; a rule file that silently never loads is the failure maxims exists to prevent |
| strategy A writes one file per source, `maxims-<source>` plus the harness's suffix; strategy B writes one block per source | removal is a file delete or a block cut, provenance is visible, and two sources never fight over one file |
| markers are HTML comments matched at line start only | every target is markdown; a marker quoted inside someone's fenced code block is not a marker |
| everything outside the marker pair is preserved byte for byte | a user may keep hand-written rules in the same file |
| rule lines are sorted by memory name | two machines with the same source produce the same file, and "nothing changed" is detectable |
| `-->` in a description is escaped, and a token a harness would expand (Claude Code's and Gemini's `@path` imports) is wrapped in backticks | an unescaped one would end the comment early or read a file into context; an undocumented syntax is escaped conservatively |
| on Claude Code the marker pair may be verbose; elsewhere it shrinks to one line | Claude Code strips block-level HTML comments before injection, so provenance is free there and costs tokens everywhere else |
| a description longer than 300 characters is cut with an ellipsis | a rule file is a budget, not a document |
| where the format requires frontmatter, maxims owns it and regenerates it with the block | the frontmatter is what keeps the file always-loaded on Cursor and Copilot; the catches below name the keys |

## Per-harness catches

| harness | the catch |
| --- | --- |
| Codex | hooks are on by default; `[features] hooks = false` in `config.toml` makes the hook inert. A project-local hook runs only once the project's `.codex` layer is trusted, and a non-managed hook must be reviewed and trusted through Codex's `/hooks` before it runs. maxims only reads that flag, never writes it, and `list` reports the tier achieved: 2 when it is false. Codex reads `AGENTS.override.md` instead of `AGENTS.md` when one exists, so a block beside an override file never loads, and it stops reading instruction files past 32 KiB combined by default. |
| Cursor | a plain `.md` in `.cursor/rules` is ignored, so the file is `.mdc` with `alwaysApply: true` frontmatter; without it the rule is silently conditional. Its `sessionStart` hook is fire-and-forget. |
| Copilot | `applyTo: "**"` is what keeps the instructions file always-loaded instead of path-scoped; a missing `applyTo` silently narrows the rule. The hook belongs to the CLI, so the IDE half stays tier 2. |
| Gemini CLI | a project hook is fingerprinted and must be trusted again whenever it changes. The hook must print nothing to stdout except one JSON object, so the staleness notice goes out as `hookSpecificOutput.additionalContext`, never as plain text. Its hook timeout is in milliseconds where the others use seconds. |
| Cline | hooks run only after "Enable Hooks" is switched on in Cline's feature settings, and the hook is an executable file named exactly `TaskStart` with a shebang. Windows is not supported by Cline's hooks. |
| OpenCode | `AGENTS.md` does not expand file references, so the per-source project file must be listed in the `instructions` array of `opencode.json`; maxims edits that array surgically. Freshness comes from a plugin file maxims writes whole and deletes on removal. |
| DeepSeek Harness | a 65,536-byte instruction budget applies to the whole file, so the writer refuses past it rather than truncating. The bridge reads its config path once at process start, so a change needs a dsh restart, and there is no per-project discovery yet. |
| Codex, Gemini CLI, DeepSeek Harness | the block lands in a file inside the repo, so it is a committed artifact that appears in every diff and PR review; this is the strongest argument for `-g` on these harnesses |
| every hook | a repeated invocation within 60 seconds of the last quiet-mode sync exits as soon as it reads the stamp, so a harness that fires more than once per session does the sync work once |
| MCP-eager harnesses | maxims bundles an MCP stub server, registered via the hidden `maxims mcp-serve` command, that exposes zero tools and runs one sync at process start. It ships dormant: no shipped harness needs it while all eight reach tier 1. |

Editing a hook registry is surgical everywhere. The writer parses the file, finds the maxims entry by its command prefix `npx -y @vivswan/maxims sync`, updates it in place or appends it, and writes to a temp file before renaming. An unparseable config is never rewritten; the run exits 4. Formatting and comments outside the entry survive byte for byte.
