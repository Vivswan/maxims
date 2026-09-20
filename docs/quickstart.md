---
order: 30
group: Start here
---

# Quickstart

One command installs a source's one-liners into your agent's always-loaded layer and registers the hook that keeps them fresh. Every console block on this page is the specified output the code is built against, not a capture from a running build.

## Install a source

```bash
npx -y @vivswan/maxims add @Vivswan/skills -g --rule --add-hook
```

- `-g` installs at user level, for every project on the machine.
- `--rule` publishes each memory's one-liner into the rule file.
- `--add-hook` registers the session-start sync hook, once per harness.

The [flag reference](cli.md#flags) has the full table. Run from inside an agent session, the plan is applied without a prompt; in a terminal, a "Proceed with installation?" confirm appears before the install line, and a refusal prints "Installation cancelled".

```text
|
o   claude-code  Agent detected - installing non-interactively
|
o  Source: https://github.com/Vivswan/skills.git
o  Repository cloned
o  Found 4 memories
|
o  Memories to install
   Vivswan Skills -> ~/.claude/rules/maxims-vivswan-skills.md
|
|    rubber-duck-before-every-commit
|
|      Use when about to commit or merge ANY change, however trivial - the
|      rubber-duck review WITH CODEX must run and converge first
|
|    ... 3 more
|
o  Installed 4 memories, 4 rule lines (~103 tokens)
o  Hook registered: SessionStart -> npx -y @vivswan/maxims sync --quiet
|
```

`add @Vivswan/skills --list` prints the same "Found N memories" and item blocks, then ends with "Run without --list to install" and writes nothing.

## What it writes

For Claude Code with `-g`, four things land on disk. Other harnesses differ only in the rule file and hook paths, which the [harness matrix](harnesses.md#the-matrix) owns.

| artifact | where | what it is |
| --- | --- | --- |
| memory bodies | `~/.agents/maxims/store/vivswan/skills/<name>.md` | the fetched files, byte for byte; a global install links nothing into any project |
| rule file | `~/.claude/rules/maxims-vivswan-skills.md` | one line per memory: the one-liner plus a `detail:` pointer to the body |
| hook entry | `~/.claude/settings.json`, under `hooks.SessionStart` | one command handler, `npx -y @vivswan/maxims sync --quiet`, registered once however many sources you add |
| state | `~/.agents/maxims/state.json` | what should be installed: the source, the selection, the rule flag, the harnesses |

The rule file for that install, cut to two of its four rule lines. Each rule line ends with the body's absolute path and its 7-character content hash; the two comment lines after the begin marker are provenance Claude Code strips before injection:

```markdown
<!-- maxims:begin @Vivswan/skills sha=fc67557 -->
<!-- managed by maxims: @Vivswan/skills - edits will be overwritten -->
<!-- update: npx maxims add @Vivswan/skills | remove: npx maxims remove @Vivswan/skills -->
- Landings are exit-conditioned: read the gate's own verdict, stop, merge in a separate command. (detail: /home/user/.agents/maxims/store/vivswan/skills/gate-exit-conditions-the-merge.md, 0f0f0f0)
- Codex rubber-duck review before EVERY commit, however trivial; coverage never transfers between reviewers. (detail: /home/user/.agents/maxims/store/vivswan/skills/rubber-duck-before-every-commit.md, a1b2c3d)
<!-- maxims:end @Vivswan/skills -->
```

The file is generated on every sync and never hand-edited; the [rule file section](harnesses.md#the-rule-file) of the harnesses page owns its grammar.

## Keep it fresh: sync

The hook runs `npx -y @vivswan/maxims sync --quiet` at every session start. Run it yourself to apply state now:

```bash
npx -y @vivswan/maxims sync
```

In quiet mode the output is only what a session must hear: a line per source that has failed to refresh for seven days, is gone, or holds invalid content, a line per write failure, and one when a file a harness reads changed. With none of those it prints nothing; the [quiet section](troubleshooting.md#--quiet-printed-nothing) owns the list.

```text
maxims: @Vivswan/skills has not refreshed since 2026-08-26 (network unreachable); rules may be out of date
maxims: rules refreshed (1 file updated)
```

`sync` touches the network only for a source past its fetch cooldown, and a failed fetch keeps the last good copy. The [cooldown flag](fetching.md#the-cap-and-the-cooldown) sets the window; the [failure paths](recovery.md#failure-paths) own what each failure does.

## Refresh now: update

```bash
npx -y @vivswan/maxims update
```

`update` refetches every source whatever the cooldown says, then runs the same sync. In quiet mode its output is the `sync` lines above; in a terminal it follows the `npx skills update` frame, which the specification leaves to be mirrored:

```text
|
o  Checking for memory updates...
o  Found 1 update(s)
|  Updating @Vivswan/skills...
|    ok Updated @Vivswan/skills
o  ok Updated 1 source(s)
|
```

With nothing to fetch the frame is one line, "ok All sources are up to date".

## See what is installed: list

```bash
npx -y @vivswan/maxims list
```

The specification fixes what `list` reports and leaves the layout to mirror `npx skills list`: a "Global Memories" or "Project Memories" header, then one row per memory with its path and an indented line naming the agents and the source. Everything past the recorded intent is re-derived when you run it, so a hand-edited hook registry is reported as it is, not as it was.

| `list` reports | derived from |
| --- | --- |
| each source, its selected memories, the fetched sha and each memory's short content hash | state |
| staleness per source, with the reason of the last failed fetch | state |
| live name collisions and the renames resolving them | the name index, rebuilt from every source's intent |
| the tier each harness achieves, and the rule file token estimate | the harness configs and rule files on disk |

## Remove

```bash
npx -y @vivswan/maxims remove @Vivswan/skills                  # a whole source
npx -y @vivswan/maxims remove rubber-duck-before-every-commit  # one memory by name
```

`remove` takes the source or memory out of state and syncs; there is no separate uninstall path, because the regenerated output no longer contains those lines.

In a terminal it lists "Memories to remove:" and asks "Are you sure you want to uninstall 2 memory(s)?" before acting, then reports "Removed 2 memories". The [non-interactive rules](installing.md#non-interactive-behavior) own what happens without a TTY.

| after `remove` | result |
| --- | --- |
| a rule file that was only the maxims block | deleted |
| a rule file with hand-written content beside the block | the block goes, the rest stays byte for byte |
| a live local source (installed with `--link`) | the store symlink is unlinked; the source directory is never touched |
| the hook | stays until the last source leaves state, then is unregistered from every harness |

## Preview before writing

Add `--dry-run` to any verb to see the plan without writing anything; the [flag reference](cli.md#flags) owns it and `--json`.

## A cloned project: install

```bash
npx -y @vivswan/maxims install
```

A project that committed `.agents/maxims.lock` carries its own source list. `install` in a fresh clone adds every source the [project lock](project-lock.md) names at project scope, then syncs, so the first session start already holds the team's rules.

## Check what a harness loads: doctor

```bash
npx -y @vivswan/maxims doctor --expect rubber-duck-before-every-commit
```

`doctor` checks each harness's rule file and hook against what that harness loads, and `--expect` turns one memory into an assertion with exit 1 when it is missing; the [doctor section](doctor.md#doctor) owns the report.
