---
order: 51
group: Reference
---

# Harnesses

Every registered harness gets a rule file in its always-loaded layer, and every harness with a hook system gets one hook that runs `npx -y @vivswan/maxims sync --quiet` on the event the hook column names. The matrix below is rendered from the harness definitions by `scripts/render_harness_matrix.ts`: `bun run docs:matrix` regenerates it, and `bun run check` fails while the page is behind the registry.

## The matrix

Ids in the first column are what `--agent` accepts. A project target is written for a project install, a global target for `-g`; a harness with no global target [skips `-g`](install.md#where-it-lands).

<!-- BEGIN GENERATED: harness-matrix -->

| id | harness | tier | project target | global target | strategy | hook | stdout | mcp stub | markers | byte budget |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `claude-code` | Claude Code | 1, or 2 when `disableAllHooks` is `true` | `.claude/rules/maxims-<source>.md` | `~/.claude/rules/maxims-<source>.md` | A | `SessionStart` entry in `.claude/settings.json` or `~/.claude/settings.json`, async | `plain` | - | stripped | 4,194,304 bytes |
| `codex` | Codex | 1, or 2 when `features.hooks` is `false` | `AGENTS.md` block | `~/.codex/AGENTS.md` block | B | `SessionStart` entry in `.codex/hooks.json` or `~/.codex/hooks.json`, async | `plain` | - | counted | - |
| `gemini-cli` | Gemini CLI | 1 | `GEMINI.md` block | `~/.gemini/GEMINI.md` block | B | `SessionStart` entry in `.gemini/settings.json` or `~/.gemini/settings.json` | `json:hookSpecificOutput.additionalContext` | - | counted | - |
| `copilot` | GitHub Copilot | 1 | `.github/instructions/maxims-<source>.instructions.md` | `~/.copilot/instructions/maxims-<source>.instructions.md` | A | maxims-owned file `.github/hooks/maxims.json` or `~/.copilot/hooks/maxims.json` | `json:additionalContext` | - | counted | - |
| `cursor` | Cursor | 1 | `.cursor/rules/maxims-<source>.mdc` | none | A | `sessionStart` entry in `.cursor/hooks.json` | `json:additional_context` | - | counted | - |
| `cline` | Cline | 1 | `.clinerules/maxims-<source>.md` | `~/Documents/Cline/Rules/maxims-<source>.md` | A | maxims-owned executable `.clinerules/hooks/TaskStart` or `~/Documents/Cline/Hooks/TaskStart` | `none` | - | counted | - |
| `opencode` | OpenCode | 1 | `.opencode/memories/maxims-<source>.md` | `~/.config/opencode/AGENTS.md` block | A project, B global | maxims-owned file `.opencode/plugins/maxims.ts` or `~/.config/opencode/plugins/maxims.ts` | `none` | - | counted | - |
| `dsh` | DeepSeek Harness | 1 | `AGENTS.md` block | `~/.dsh/AGENTS.md` block | B | custom | - | - | counted | 64,512 bytes |
| `devin` | Devin Local | 1 | `AGENTS.md` block | `~/.config/devin/AGENTS.md` block | B | `SessionStart` entry in `.devin/config.json` or `~/.config/devin/config.json` | `json:hookSpecificOutput.additionalContext` | `.devin/mcp_config.json` or `~/.config/devin/mcp_config.json` | counted | - |
| `windsurf` | Windsurf Cascade | 1 | `.devin/rules/maxims-<source>.md` | `~/.codeium/windsurf/memories/global_rules.md` block | A project, B global | `pre_user_prompt` entry in `.windsurf/hooks.json` or `~/.codeium/windsurf/hooks.json` | `none` | `~/.codeium/windsurf/mcp_config.json` | counted | project 12,000 bytes, global 6,000 bytes |
| `zed` | Zed | 2 | `AGENTS.md` block, written into the first existing of `.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` | `~/.config/zed/AGENTS.md` block | B | none | - | `.zed/settings.json` or `~/.config/zed/settings.json` | counted | - |
| `amp` | Amp | 1 | `AGENTS.md` block, written into the first existing of `AGENTS.md`, `AGENT.md`, `CLAUDE.md` | `~/.config/amp/AGENTS.md` block | B | maxims-owned file `.amp/plugins/maxims.ts` or `~/.config/amp/plugins/maxims.ts` | `none` | `.amp/settings.json` or `~/.config/amp/settings.json` | counted | - |
| `warp` | Warp | 2 | `AGENTS.md` block, written into the first existing of `WARP.md`, `AGENTS.md` | none | B | none | - | `~/.warp/.mcp.json` | counted | - |
| `pi` | Pi | 1 | `AGENTS.md` block, written into the first existing of `AGENTS.override.md`, `AGENTS.md` | `~/.pi/agent/AGENTS.md` block, written into the first existing of `~/.pi/agent/AGENTS.override.md`, `~/.pi/agent/AGENTS.md` | B | maxims-owned file `.pi/extensions/maxims.ts` or `~/.pi/agent/extensions/maxims.ts` | `none` | - | counted | - |

<!-- END GENERATED: harness-matrix -->

| column | how to read it |
| --- | --- |
| `tier` | the declared tier; the config key that demotes it to 2 follows when the definition names one |
| `project target`, `global target` | the file written for a project install and for `-g`; `none` means that scope is skipped. A block cell that lists files is written into the first of them that already exists, and the named file is created only when none does |
| `strategy` | A writes one whole file per source into a rules directory, so removal is a file delete; B writes a managed block into a shared instructions file the user also owns, so removal cuts the block and keeps the rest |
| `hook` | the registry entry, hook file, or custom reconcile that runs the sync command, with its path for each scope the harness installs into; a maxims-owned file is written whole and deleted on removal, so nothing else belongs in it; `custom` means the definition writes its own files, named in the catches below |
| `stdout` | how sync's output reaches the agent: `plain` text becomes context, a `json:` value names the key inside the one JSON object the harness reads, `none` means the hook passes nothing of sync's on, `-` means no declared stdout variant, a custom hook or no hook |
| `mcp stub` | the MCP servers file, per scope, where the definition registers the bundled stub server whose start runs one sync; `-` when the definition names none |
| `markers` | `stripped` when the harness drops HTML comments before injection, so the marker pair is free; `counted` when they ride into context |
| `byte budget` | the largest rule file the writer will produce for the harness, refusing past it; `-` when the definition declares no budget, so the writer enforces none |

Memory bodies do not vary by harness. They live in the maxims store and rule lines point at them; a project install links them into `.agents/memories/` for every harness, the convention `npx skills` set with `.agents/skills/`.

A harness you declare in `harnesses.json` has no row here, because it exists only on the machine that declares it; the [adding a harness](adding-a-harness.md#your-own-harnesses-in-harnessesjson) page owns that file.

## Tiers

| tier | meaning | freshness |
| --- | --- | --- |
| 1 | a rule file plus a hook that runs the sync | loads every session and refreshes itself |
| 2 | a rule file, no hook | kept fresh by [any hooked harness on the same machine](keep-fresh.md#one-hook-refreshes-every-harness), or by the MCP stub where the `mcp stub` column names a file; manual otherwise |
| 3 | unsupported | no file-based always-loaded layer exists, so there is nowhere to put a guarantee; web-only agents with UI-stored rules |

The tier a harness achieves is a sync-time result that `list` reports. It is not stored, so a config edit that demotes a harness is visible the next time you look.

## The rule file

Generated on every sync, compared to what is on disk, and written only on a difference. Hand edits inside the block are overwritten by design; `--dry-run` shows what would be lost, and the marker text says where the real edit belongs.

```markdown
<!-- maxims:begin @Vivswan/skills sha=fc67557 -->
- Codex rubber-duck review before EVERY commit, however trivial. (detail: ~/.agents/maxims/store/vivswan/skills/rubber-duck-before-every-commit.md)
<!-- maxims:end @Vivswan/skills -->
```

| rule | reason |
| --- | --- |
| the rule file is a real file on every harness, never a symlink | a rule file that silently never loads is the failure maxims exists to prevent; the [design decision](design-decisions.md#harnesses) records the reported Claude Code behavior behind it |
| strategy A writes one file per source, `maxims-<source>` plus the harness's suffix; strategy B writes one block per source | removal is a file delete or a block cut, provenance is visible, and two sources never fight over one file |
| markers are HTML comments matched at line start only | every target is markdown; a marker quoted inside someone's fenced code block is not a marker |
| everything outside the marker pair is preserved byte for byte | a user may keep hand-written rules in the same file |
| rule lines are sorted by memory name | two machines with the same source produce the same file, and "nothing changed" is detectable |
| `-->` in a description is escaped, and a token a harness would expand (Claude Code's and Gemini's `@path` imports) is wrapped in backticks | an unescaped one would end the comment early or read a file into context; an undocumented syntax is escaped conservatively |
| on Claude Code the marker pair may be verbose; elsewhere it shrinks to one line | stripping of block-level HTML comments before injection is verified only for Claude Code, so provenance is free there; on every other harness it is not known to be stripped, so the markers are assumed to cost tokens |
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
| DeepSeek Harness | dsh renders every instruction file it finds into one 65,536-byte block and truncates the most specific file past it, so the writer refuses a rule file over 64,512 bytes (the rest is dsh's own framing) rather than truncating. |
| DeepSeek Harness hook | dsh has no per-project config discovery, so the hook is one `@deepseek-ai/dsh-hooks-claude-code` bridge row in `$DSH_HOME/cordis.patch.yml` whatever the install scope, pointing by absolute path at a maxims-owned `$DSH_HOME/maxims-hooks.json`. The bridge reads that file once at process start, so a new or changed row needs a dsh restart. |
| Codex, Gemini CLI, DeepSeek Harness | the block lands in a file inside the repo, so it is a committed artifact that appears in every diff and PR review; this is the strongest argument for `-g` on these harnesses |
| every hook | a repeated invocation within 60 seconds of the last quiet-mode sync exits as soon as it reads the stamp, so a harness that fires more than once per session does the sync work once |
| MCP-eager harnesses | maxims bundles an MCP stub server, registered via the hidden `maxims mcp-serve` command, that exposes zero tools and runs one sync at process start. It is registered in the file the `mcp stub` column names, so a harness that starts its MCP servers eagerly syncs at launch even with no hook. |

Editing a hook registry is surgical everywhere: the writer parses the file, finds the maxims entry by its command prefix `npx -y @vivswan/maxims sync`, and updates it in place or appends it.

| rule | effect |
| --- | --- |
| the write is a temp file, then a rename | a half-written registry has no representation |
| an unparsable config is never rewritten | the run exits 4 |
| formatting and comments outside the entry survive byte for byte | the user's own hooks and layout are untouched |
