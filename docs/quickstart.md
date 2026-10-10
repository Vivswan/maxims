---
order: 20
group: Start here
---

# Quickstart

One command installs a source's one-liners into your agent's always-loaded layer and registers the hook that keeps them fresh. This page is that command and what it writes; the console block below is captured from the built CLI.

## Install a source

```bash
npx -y @vivswan/maxims add @Octocat/rules -g --rule --add-hook
```

`@Octocat/rules` stands for your own rules repository.

- `-g` installs at user level, for every project on the machine.
- `--rule` publishes each memory's one-liner into the rule file.
- `--add-hook` registers the session-start sync hook, once per harness.

The [flag reference](cli.md#flags) has the full table. Run from inside an agent session, the plan is applied without a prompt; in a terminal, a "Proceed with installation?" confirm appears before the install line, and a refusal prints "Installation cancelled".

The output with stdout piped, as an agent or a log sees it. On a terminal inside an agent session the frame opens with `o   claude-code  Agent detected - installing non-interactively` and the item list folds to one entry plus `... 3 more`.

```text
|
o  Source: https://github.com/Octocat/rules.git
o  Repository cloned
o  Found 4 memories
o  First source from github.com/octocat
   https://github.com/Octocat/rules.git
   commit 77769dc, not pinned (tracks HEAD)
   4 memories
|
o  Memories to install
   Octocat Rules -> ~/.claude/rules/maxims-octocat-rules.md
|
|    commit-small-and-often
|
|      Keep every commit to one change - a reviewer reads a small diff in one
|      pass
|
|    never-retry-without-a-cap
|
|      Never retry a failed call without a cap - an unbounded retry loop hides
|      an outage from everyone
|
|    prefer-timeouts-to-hangs
|
|      Use when a call leaves the process, however small - give it a timeout,
|      since a hang is worse than a clear failure
|
|    tests-before-the-fix
|
|      A fix lands with the test that failed before it, never a test written
|      after the fact
|
o  Installed 4 memories, 4 rule lines (~196 tokens)
o  Hook registered: SessionStart -> npx -y @vivswan/maxims sync --quiet
!  ~196 tokens in /home/user/.claude/rules/maxims-octocat-rules.md
!  maxims: registered the maxims hook in /home/user/.claude/settings.json
|
```

`add @Octocat/rules --list` previews the source and writes nothing; [what gets installed](install.md#what-gets-installed) shows its output. After the install, `maxims show <memory>` prints [one memory in full](check.md#read-one-memory-or-source-show).

## What it writes

For Claude Code with `-g`, four things land on disk. Other harnesses differ only in the rule file and hook paths, which the [harness matrix](harnesses.md#the-matrix) owns.

| artifact | where | what it is |
| --- | --- | --- |
| memory bodies | `~/.agents/maxims/store/octocat/rules/memories/<name>.md` | the fetched files, byte for byte; a global install links nothing into any project |
| rule file | `~/.claude/rules/maxims-octocat-rules.md` | one line per memory: the one-liner plus a `detail:` pointer to the body |
| hook entry | `~/.claude/settings.json`, under `hooks.SessionStart` | one command handler, `npx -y @vivswan/maxims sync --quiet`, registered once however many sources you add |
| state | `~/.agents/maxims/state.json` | what should be installed: the source, the selection, the rule flag, the harnesses |

The rule file for that install, cut to two of its four rule lines, with illustrative hashes. Each rule line ends with the body's absolute path and its 7-character content hash; the two comment lines after the begin marker are provenance Claude Code strips before injection:

```markdown
<!-- maxims:begin @Octocat/rules sha=77769dc1e2b3a4c5d6e7f8091a2b3c4d5e6f7089 -->
<!-- managed by maxims: @Octocat/rules - edits will be overwritten -->
<!-- update: npx -y @vivswan/maxims add @Octocat/rules | remove: npx -y @vivswan/maxims remove @Octocat/rules -->
- One change per commit: a reviewer reads a small diff in one pass, a revert takes back one thing. (detail: /home/user/.agents/maxims/store/octocat/rules/memories/commit-small-and-often.md, 0f0f0f0)
- A timeout on EVERY call that leaves the process, however short; a hang is worse than a clear failure. (detail: /home/user/.agents/maxims/store/octocat/rules/memories/prefer-timeouts-to-hangs.md, a1b2c3d)
<!-- maxims:end @Octocat/rules -->
```

The file is generated on every sync and never hand-edited; the [rule file section](harnesses.md#the-rule-file) of the harnesses page owns its grammar.

## Preview before writing

Add `--dry-run` to any verb to see the plan without writing anything; the [flag reference](cli.md#flags) owns it and `--json`.

## What happens next

The hook now runs `npx -y @vivswan/maxims sync --quiet` at every session start, and the [session hook section](keep-fresh.md#the-session-hook) owns what that run prints and when it fetches. To see what each harness loads right now, run [`doctor`](check.md#doctor-what-each-harness-loads).
