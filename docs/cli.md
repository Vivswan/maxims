---
order: 50
group: Reference
---

# CLI reference

Every verb, flag, exit code, and prompt rule of `npx -y @vivswan/maxims`, as specified. The npm package is `@vivswan/maxims`; the binary it installs is `maxims`. The command shapes mirror `npx skills`: same flags, same short forms, same confirmation and non-interactive behavior, so a person running both never has to remember which one spells a thing differently.

## Verbs

| verb | what it does | touches the network |
| --- | --- | --- |
| `add <source>` | fetch the source, record it in state (destination, selection, rule flag, harnesses), then run an initial sync | yes |
| `sync` | apply state to this machine and project: link bodies, regenerate rule files, reconcile hooks | only for a source past its cooldown |
| `update` | refetch every source into the store, ignoring the cooldown, then sync | always |
| `remove <source or name>` | take a source or one memory out of state, then sync | no |
| `list` | what state holds, per source and per harness, with everything past intent re-derived on the spot | no |
| `init [name]` | scaffold a contract-valid memory file | no |

A source is `@owner/repo`, `owner/repo`, a GitHub URL, any other git remote URL (https, http, ssh, git, or the `git@host:path` form), or a local directory. `.` installs the current working tree as a live source. The `@` in `@owner/repo` is cosmetic, as it is for `skills`.

`sync` and `update` take no source argument; state supplies it. `remove` takes either a source or a bare memory name, and a bare name two sources both provide is ambiguous, so it exits 1 and prints the qualified forms.

## Flags

| flag | verbs | default | conflicts and notes |
| --- | --- | --- | --- |
| `-g, --global` | add, remove | auto | with `-o` or `-p`: exit 1, two destinations. On a harness with no global target, warns and skips that harness. |
| `-p, --project` | add, remove | auto | the explicit opposite of `-g`. Without either, a GitHub source installs to the project when inside one, else global, as in `skills`; a local directory source defaults to global, see [security](security.md#where-personal-text-can-leak). |
| `-o, --out <dir>` | add, remove | off | with `-g` or `-p`: exit 1. Relative paths resolve against the cwd, not the project root. |
| `-m, --memory <names>` | add, remove | `*` | comma list, repeatable, `*` for all. Re-running `add` with a different list replaces the recorded one, shown in the plan first, never unions. A name the source lacks: exit 3, nothing written. |
| `-a, --agent <agents>` | add, remove, sync, update | detected | comma list, `*` for all; ids are the [harness matrix](harnesses.md#the-matrix) rows. On `sync` and `update`, limits the run to those harnesses. |
| `-l, --list` | add | off | read-only preview of the source. Ignores and warns on `--rule`, `--add-hook`, `-o`, `-y`; never writes, never touches state. |
| `-y, --yes` | add, remove | auto | skips the confirm prompt. Implied when non-interactive, see below. |
| `--all` | add, remove | off | on `add`, shorthand for `--memory '*' --agent '*' -y`; on `remove`, every installed source with `-y` implied. |
| `--rule` | add | off | records that this source's one-liners also go to the rule file; every sync regenerates them. Not implied by `--add-hook`. `remove` always removes rule lines. |
| `--add-hook` | add | off | registers the harness's single sync hook if absent; it carries no source and no filter. Does not imply `--rule`. An install from `.` registers no hook, so an unpushed edit is never clobbered by a refresh. |
| `--quiet` | all | off | one-line output and fail-soft, see the exit codes below. The hook's mode. |
| `--copy` | add | off | materialize bodies at the destination instead of linking into the canonical home. For symlink-hostile setups, as `skills --copy`. |
| `--from <path>` | add | `memories/` | the folder in the source to read memories from; the [source layout](memory-files.md#layout-in-a-source) owns it. |
| `--full-depth` | add | off | scan the whole source, as `skills --full-depth`; the [source layout](memory-files.md#layout-in-a-source) owns it. |
| `--link` | add | off | local sources only: the store entry is a symlink to the source directory, so edits are live. Defaults on for `.`. No representation for a fetched source. |
| `--pin <sha or tag>` | add | off | GitHub and git sources: track this ref instead of the default branch. Not offered for a local directory. |
| `--paths <glob>` | add | off | opt-in path scoping, written in the target harness's own syntax and stored per source; warns and is skipped on a harness with no scoping mechanism. A scoped rule loads only when matching files are touched, so it trades away "every session". |
| `--no-fetch` | sync | off | suppress the cooldown-triggered refresh for a guaranteed-offline run. |
| `--dry-run` | all | off | prints the exact plan and diff, writes nothing, exit 0. |
| `--json` | all | off | the same plan as one JSON document, for CI assertions. |
| `--cooldown <days>` | add, sync, update | 7 | see below. |
| `--cap <n>` | add, sync, update | 25 | see below. |
| `-h, --help`, `-v, --version` | all | | standard. |

Flags compose. The everyday invocation, `add @Vivswan/skills -g --rule --add-hook`, is the [quickstart](quickstart.md#install-a-source).

## The cap and the cooldown

Two numbers apply to every source and live in state under `config`, not on a hook command line, so a hook has nothing to drift from. Both flags are maxims-only; `skills` has no analog.

| flag | writes | default | what it governs |
| --- | --- | --- | --- |
| `--cooldown <days>` | `config.cooldownDays` | 7 | how long `sync` goes without refetching a source; `update` ignores it |
| `--cap <n>` | `config.ruleCap` | 25 | the most rule lines one source may publish; over it, the whole source is refused with exit 8, never truncated |

The cap is a count, and it is a hard gate. The token estimate printed beside every rule file write is a report and never blocks. The two ways out of exit 8 are named in its hint, narrow with `--memory` or raise `--cap`.

## init

`maxims init <name>` writes `memories/<name>.md` under the current directory, creating `memories/` if needed, and refuses to overwrite an existing file. The file passes the [memory contract](memory-files.md#the-contract) as written: `name` set, a placeholder `description`, `metadata.node_type: memory`, `metadata.type: feedback`, and `**Why:**` and `**How to apply:**` stubs in the body. Without a name it prompts; non-interactively without one it exits 1.

## Exit codes

| code | meaning | when |
| --- | --- | --- |
| 0 | success, or nothing to do | includes "already up to date" and every `--quiet` outcome |
| 1 | usage error | unknown flag, `-g` with `-o`, ambiguous bare name, a non-interactive `remove` without `--yes` |
| 2 | source unresolvable | repo not found, no read access, local directory missing |
| 3 | nothing resolved to install | a `--memory` name the source lacks, a filter matching nothing, a source with zero valid memories |
| 4 | destination write failed | permissions, read-only filesystem, disk full, an unparseable harness config |
| 5 | store locked | another maxims process held the lock past the wait |
| 6 | name collision | an incoming memory's name is owned by another source and no rename was chosen |
| 7 | unmet dependency | a `[[wikilink]]` target does not resolve |
| 8 | rule cap exceeded | the source's rule-flagged set is over the cap |

Codes 3, 6, 7, and 8 are one family. The install would be incomplete, so nothing at all is written; a partial install is a set of rules the user believes is loaded and is not.

`--quiet` collapses every non-zero code to 0 after logging. This is a requirement, not an optimization. A harness shows a failing hook to the user at every session start, and fail-soft is what keeps that notice from becoming permanent.

## Name collisions and renames

A memory's name is its identity. When an incoming memory's name is already owned by another installed source, `add` stops instead of skipping it, because a silently skipped rule is a rule the user believes is loaded.

```text
index:      gate-exit-conditions-the-merge  -> owned by @Vivswan/skills
incoming:   gate-exit-conditions-the-merge  from @example-user/dotfiles      COLLISION
interactive:      rename to gate-exit-conditions-the-merge-dotfiles; recorded in state
non-interactive:  exit 6, nothing written
result:           two rule lines, two names, one rename entry applied by every later sync
```

The rename is a local identity only. The stored file keeps its upstream name and body, the mapping lives in state, and an upstream rename of that file retires the mapping with it.

## Non-interactive behavior

Detection mirrors `skills`, which prints "Agent detected - installing non-interactively" when run from inside an agent.

| stdout is a TTY | agent env detected | `--yes` | behavior |
| --- | --- | --- | --- |
| yes | no | no | full prompts: confirm the plan, confirm hook registration |
| yes | no | yes | no prompts, full output |
| yes | yes | either | no prompts, full output, "Agent detected" banner |
| no | either | either | no prompts, plain output with no spinner and no color, `--yes` implied |
| any | any | any, with `--quiet` | one line or nothing; a needed prompt takes the safe branch |

The safe branch on `add` and `sync` is proceed, since both are idempotent and reversible. The safe branch on `remove` is abort with exit 1. A collision prompt has no safe branch, so non-interactively it is exit 6 with nothing written.

## Parity with npx skills

`skills` is the naming authority, so the same concept gets the same flag, short form, and value shape. Every divergence has a reason in this table, and the specified guard is a test that pins the maxims column against a captured `skills --help`.

| npx skills | maxims | parity | why |
| --- | --- | --- | --- |
| `-g, --global` | `-g, --global` | same | |
| `-p, --project` | `-p, --project` | same | `skills` carries it on `update` only; maxims offers it on `add` and `remove` so `-g` has a visible opposite |
| `-s, --skill <skills>` | `-m, --memory <memories>` | analog | only the noun differs; the value shape is copied exactly |
| `-a, --agent <agents>` | `-a, --agent <agents>` | same | |
| `-l, --list` | `-l, --list` | same | |
| `-y, --yes` | `-y, --yes` | same | |
| `--all` | `--all` | same | same shorthand on both verbs |
| `--copy` | `--copy` | same | materialize instead of link |
| `--full-depth` | `--full-depth` | same | `skills` searches past a root `SKILL.md`; maxims past `memories/` |
| `--metadata <json>` | none | diverge | install telemetry; maxims ships none, see [security](security.md) |
| `--subagent <names>` | none | diverge | a rule file has no subagent scope to target |
| `--owner <owner>` | none | diverge | belongs to `find`, which maxims lacks |
| none | `-o, --out <dir>` | maxims-only | a team's rule file lives in a repo path, not a scope |
| none | `--rule`, `--add-hook`, `--quiet` | maxims-only | skills have no always-loaded layer and no hook that runs unattended |
| none | `--link` | maxims-only | a symlinked store entry for a local source is an open request on skills (vercel-labs/skills#748) that maxims ships |
| none | `--cooldown`, `--cap` | maxims-only | the refresh window and the rule budget have no skills concept |
| `update`, `upgrade` | `update` | same | state-driven, no source argument |
| `use <pkg>@<skill>` | none | diverge | a one-liner is not a workflow you run once without installing |
| `find [query]` | none | diverge | no registry of memory repos exists yet |
| `init [name]` | `init [name]` | same | scaffolds one file in the source layout |
| `list`, `ls` | `list` | same | the read command for state |
| `experimental_install` | `sync` | analog | both restore the installed set from a state record; maxims makes it a first-class verb |
| `experimental_sync` | `sync` | same name | same verb, same instinct |
