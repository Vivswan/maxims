---
order: 52
group: Reference
---

# Installing a source

What `add` does with each of its flags, from the everyday command to a scripted install that resolves a name collision. The [CLI reference](cli.md#flags) has the one-row summary of every flag; this page has the behavior behind the `add` and `remove` rows. What a source must contain is on the [memory files page](memory-files.md).

```bash
npx -y @vivswan/maxims add @Vivswan/skills -g --rule --add-hook
```

The [quickstart](quickstart.md#install-a-source) shows what that command prints and writes. Every flag below changes one part of it.

## Where it lands

| flag | destination | notes |
| --- | --- | --- |
| `-g, --global` | the user scope: every project on the machine | on a harness with no global target, warns and skips that harness |
| `-p, --project` | the project scope: the git checkout you are in | the explicit opposite of `-g` |
| neither | a GitHub source installs to the project when inside one, else to the user scope, as in `skills` | a local directory source defaults to the user scope, so personal text stays out of the repo; see [security](security.md#where-personal-text-can-leak) |
| `-o, --out <dir>` | an output folder for a rule file no harness owns, such as a team folder inside a repo | neither scope; a relative path resolves against the cwd, not the project root |

Two of `-g`, `-p`, and `-o` together is exit 1, "two destinations given".

## What gets installed

| flag | selection |
| --- | --- |
| none | every memory in the source (`*`) |
| `-m, --memory <names>` | a comma list, repeatable; `*` means all. A name the source lacks is exit 3 with nothing written |
| `--all` | shorthand for `--memory '*' --agent '*' -y` |
| `-l, --list` | a read-only preview: the same "Found N memories" and item blocks, then "Run without --list to install". It writes nothing, never touches state, and ignores `--rule`, `--add-hook`, `-o`, and `-y` with a warning |

Re-running `add` with a different `--memory` list replaces the recorded one, shown in the plan first. It never unions.

The specified output of `add @Vivswan/skills --list`:

```text
|
o  Source: https://github.com/Vivswan/skills.git
o  Repository cloned
o  Found 4 memories
|
o  Available Memories
|    gate-exit-conditions-the-merge
|
|      Never chain a merge in the same command as reading a gate log - condition
|      the merge on the gate's exit code
|
|    no-sleep-waiting-on-subagents
|
|      Never sleep or poll waiting on a background subagent - its completion
|      re-invokes the session on its own
|
|    rubber-duck-before-every-commit
|
|      Use when about to commit or merge ANY change, however trivial - the
|      rubber-duck review WITH CODEX must run and converge first
|
|    skip-unfit-skills
|
|      The agent may skip an invoked skill that does not fit the task, but must
|      say why
|
o  Run without --list to install
```

On `remove`, `--all` means every installed source and spells out `-y`, so it is the one `remove` that needs no separate `-y`.

## Two separate choices

`--rule` and `--add-hook` record two different intents, and neither implies the other.

| flag | records | every later sync |
| --- | --- | --- |
| `--rule` | this source's one-liners go to the rule file | regenerates the rule lines; `remove` always removes them |
| `--add-hook` | the harness's single sync hook is wanted | keeps the hook registered; it carries no source and no filter, so the tenth source adds nothing to it |

An install from `.` registers no hook, so an unpushed edit is never clobbered by a refresh.

## Which harnesses

`-a, --agent <ids>` is a comma list, `*` for all, with ids from the [harness matrix](harnesses.md#the-matrix). Without it, the detected harnesses are used. To change one harness of an installed source without a refetch, use `link` or `unlink`; the [verb notes](cli.md#verbs) own how they differ from `add -a`.

## Bodies

| flag | where the body lives | for |
| --- | --- | --- |
| none | the [canonical home](state-and-store.md#the-canonical-home), linked from the destination | every setup where a symlink works |
| `--copy` | a copy at the destination | symlink-hostile setups, as `skills --copy` |
| `--link` | the store entry is a symlink to the source directory, so edits are live | local sources only; on by default for `.`, and it has no representation for a fetched source |

## Refs

`--pin <sha or tag>` tracks that ref instead of the default branch, for GitHub and git sources. It is not offered for a local directory. A GitHub URL with a `/tree/<ref>` segment sets the same pin, as the [source forms](cli.md#sources) show.

## Path scoping

`--paths <glob>` writes the rule file in the target harness's own path-scoping syntax and is stored per source. A harness with no scoping mechanism warns and skips it.

A scoped rule loads only when matching files are touched, so it trades away "every session". It is opt-in and never a default.

## Name collisions and renames

A memory's name is its identity. When an incoming memory's name is already owned by another installed source, `add` stops instead of skipping it, because a silently skipped rule is a rule the user believes is loaded.

```text
index:      gate-exit-conditions-the-merge  -> owned by @Vivswan/skills
incoming:   gate-exit-conditions-the-merge  from @example-user/dotfiles      COLLISION
interactive:      rename to gate-exit-conditions-the-merge-dotfiles; recorded in state
non-interactive:  exit 6, nothing written, unless --rename names the pair
result:           two rule lines, two names, one rename entry applied by every later sync
```

The specified output when the prompt cannot be shown:

```text
 ERROR  gate-exit-conditions-the-merge is owned by @a/b
Tip: --rename gate-exit-conditions-the-merge=<new>
```

`--rename gate-exit-conditions-the-merge=gate-exit-conditions-the-merge-dotfiles` records the same entry the prompt would, so a scripted `add` never meets exit 6 for a collision it knows about. It repeats, one pair per colliding memory.

The rename is a local identity only. The stored file keeps its upstream name and body, the mapping lives in state, and an upstream rename of that file retires the mapping with it.

## Non-interactive behavior

Detection mirrors `skills`, which prints "Agent detected - installing non-interactively" when run from inside an agent.

| stdout is a TTY | agent env detected | `--yes` | behavior |
| --- | --- | --- | --- |
| yes | no | no | full prompts: confirm the plan, confirm hook registration |
| yes | no | yes | no prompts, full output |
| yes | yes | either | no prompts, full output, "Agent detected" banner |
| no | either | either | no prompts, plain output with no spinner and no color; `--yes` implied on `add` and `sync` only |
| any | any | any, with `--quiet` | one line or nothing; a needed prompt takes the branch below |

Without a prompt, `add` and `sync` proceed as if `--yes` were given. `remove` without an explicit `-y` aborts with exit 1, and `--all` spells `-y` out, so it is the one form that passes.

`disable`, `enable`, `link`, and `unlink` take no `-y`, since they never prompt. A collision without `--rename` is exit 6 with nothing written.

The specified output of a non-interactive `remove` without `-y`:

```text
|
o  Memories to remove: @a/b
 ERROR  Interactive prompt required but stdin is not a TTY. Nothing was removed. Use -y to run non-interactively.
```
