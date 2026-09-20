---
order: 20
group: Start here
---

# Quickstart

One command installs a source's one-liners into your agent's always-loaded layer and registers the hook that keeps them fresh. This page is that command and what it writes; every console block on it is the specified output the code is built against, not a capture from a running build.

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
<!-- update: npx -y @vivswan/maxims add @Vivswan/skills | remove: npx -y @vivswan/maxims remove @Vivswan/skills -->
- Landings are exit-conditioned: read the gate's own verdict, stop, merge in a separate command. (detail: /home/user/.agents/maxims/store/vivswan/skills/gate-exit-conditions-the-merge.md, 0f0f0f0)
- Codex rubber-duck review before EVERY commit, however trivial; coverage never transfers between reviewers. (detail: /home/user/.agents/maxims/store/vivswan/skills/rubber-duck-before-every-commit.md, a1b2c3d)
<!-- maxims:end @Vivswan/skills -->
```

The file is generated on every sync and never hand-edited; the [rule file section](harnesses.md#the-rule-file) of the harnesses page owns its grammar.

## Preview before writing

Add `--dry-run` to any verb to see the plan without writing anything; the [flag reference](cli.md#flags) owns it and `--json`.

## What happens next

The hook now runs `npx -y @vivswan/maxims sync --quiet` at every session start, and the [session hook section](keep-fresh.md#the-session-hook) owns what that run prints and when it fetches. To see what each harness loads right now, run [`doctor`](check.md#doctor-what-each-harness-loads).
