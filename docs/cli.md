---
order: 50
group: Reference
---

# CLI reference

Every verb, flag, exit code, and prompt rule of `npx -y @vivswan/maxims`, as specified. The npm package is `@vivswan/maxims`; the binary it installs is `maxims`. The command shapes mirror `npx skills`: same flags, same short forms, same confirmation and non-interactive behavior, so a person running both never has to remember which one spells a thing differently.

## Verbs

| verb | alias | what it does | touches the network |
| --- | --- | --- | --- |
| `add <source>` | `a` | fetch the source, record it in state (destination, selection, rule flag, harnesses), then run an initial sync | yes |
| `sync` | | apply state to this machine and project: link bodies, regenerate rule files, reconcile hooks | only for a source past its cooldown |
| `update` | `check`, `upgrade` | refetch every source into the store, ignoring the cooldown, then sync | always |
| `remove <source or name>` | `rm`, `r` | take a source or one memory out of state, then sync | no |
| `list` | `ls` | what state holds, per source and per harness, with everything past intent re-derived on the spot | no |
| `install` | `i` | replay the project's [manifest](state-and-store.md#the-project-manifest): add every source it names at project scope, then sync | yes |
| `link <source> -a <harness>` | | add a harness to a source's recorded list without a refetch, then sync | no |
| `unlink <source> -a <harness>` | | drop a harness from a source's recorded list, then sync | no |
| `disable <memory>` | | keep a memory in state but withhold its rule line and link at this scope, then sync | no |
| `enable <memory>` | | undo `disable`, then sync | no |
| `doctor` | | report, per harness, whether the rule file and hook are where the harness loads them | no |
| `config set\|get\|unset <key> [value]` | | read or write a [user default](#user-defaults-in-configjson) | no |
| `init [name]` | | scaffold a contract-valid memory file | no |

A source is `@owner/repo`, `owner/repo`, a GitHub URL, any other git remote URL (https, http, ssh, git, or the `git@host:path` form), or a local directory. `.` installs the current working tree as a live source. The `@` in `@owner/repo` is cosmetic, as it is for `skills`.

| source form | what it means |
| --- | --- |
| `@owner/repo@memory-name` | the same as `@owner/repo -m memory-name`: one memory, by name |
| `https://github.com/owner/repo/tree/<ref>/...` | a GitHub URL whose `/tree/<ref>/` segment sets the ref, as `--pin <ref>` would |
| `https://git.example.com/team/rules.git`, `git@host:path` | any git remote, stored verbatim; the [fetch section](#how-a-source-is-fetched) owns what happens to it |

`sync`, `update`, `install`, and `doctor` take no source argument; state or the manifest supplies it. `remove` takes either a source or a bare memory name, and a bare name two sources both provide is ambiguous, so it exits 1 and prints the qualified forms.

`link` and `unlink` change one field, the source's harness list, and never refetch. `add -a` on an installed source still replaces the whole list, as it replaces the selection.

`disable` and `enable` act at the scope you are in, or the one `-g` or `-p` names. A memory disabled at project scope stays live for `-g`, and the other way round; the [state page](state-and-store.md#the-schema) owns where the list is kept.

## Flags

| flag | verbs | default | conflicts and notes |
| --- | --- | --- | --- |
| `-g, --global` | add, remove, disable, enable | auto | with `-o` or `-p`: exit 1, two destinations. On a harness with no global target, warns and skips that harness. |
| `-p, --project` | add, remove, disable, enable | auto | the explicit opposite of `-g`. Without either, a GitHub source installs to the project when inside one, else global, as in `skills`; a local directory source defaults to global, see [security](security.md#where-personal-text-can-leak). |
| `-o, --out <dir>` | add, remove | off | with `-g` or `-p`: exit 1. Relative paths resolve against the cwd, not the project root. |
| `-m, --memory <names>` | add, remove | `*` | comma list, repeatable, `*` for all. Re-running `add` with a different list replaces the recorded one, shown in the plan first, never unions. A name the source lacks: exit 3, nothing written. |
| `-a, --agent <agents>` | add, remove, sync, update, link, unlink | detected | comma list, `*` for all; ids are the [harness matrix](harnesses.md#the-matrix) rows. On `sync` and `update`, limits the run to those harnesses. |
| `-l, --list` | add | off | read-only preview of the source. Ignores and warns on `--rule`, `--add-hook`, `-o`, `-y`; never writes, never touches state. |
| `-y, --yes` | add, remove | auto | skips the confirm prompt. Implied non-interactively on `add` and `sync` only, see [below](#non-interactive-behavior). |
| `--auth` | add | off | use your `gh` login for this source, recorded as `intent.auth` so every refresh uses it too; the [fetch section](#how-a-source-is-fetched) owns the default. |
| `--rename <upstream>=<local>` | add | off | resolve a [name collision](#name-collisions-and-renames) without a prompt; repeatable, one pair per colliding memory. |
| `--allow-hidden` | add | off | install a source that carries [hidden characters](memory-files.md#hidden-characters-are-refused) anyway. |
| `--expect <name or @owner/repo/name>` | doctor | off | assert one memory has a rule line in place; repeatable. A missing one exits 1. |
| `--all` | add, remove | off | on `add`, shorthand for `--memory '*' --agent '*' -y`; on `remove`, every installed source, and it spells out `-y`, so it is the one `remove` that needs no separate `-y`. |
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
| `--cooldown <days>` | add, sync, update | 7 | see [the cap and the cooldown](#the-cap-and-the-cooldown). |
| `--cap <n>` | add, sync, update | 25 | see [the cap and the cooldown](#the-cap-and-the-cooldown). |
| `-h, --help`, `-v, --version` | all | | standard. |

A value flag takes `--flag value` or `--flag=value`. A list flag takes a comma list and may repeat, so `-m a,b -m c` selects three memories.

Flags compose. The everyday invocation, `add @Vivswan/skills -g --rule --add-hook`, is the [quickstart](quickstart.md#install-a-source).

Two scopes exist, project (`-p`) and user (`-g`). `-o` is the escape hatch for a rule file no harness owns, such as a team folder inside a repo, and it is neither scope.

## User defaults in config.json

`<MAXIMS_HOME>/config.json` holds the defaults you would otherwise repeat on every command. It is a file beside state, never a part of it. `cooldownDays` and `ruleCap` are the two keys `sync` reads, since they govern every run; each other key fills in a flag you did not type on `add`, and what `add` records is ordinary intent.

| key | stands in for | default when unset |
| --- | --- | --- |
| `agents` | `-a <agents>` | the detected harnesses |
| `yes` | `-y` | prompt when interactive |
| `addHook` | `--add-hook` | off |
| `rule` | `--rule` | off |
| `cooldownDays` | `--cooldown <days>` | 7 |
| `ruleCap` | `--cap <n>` | 25 |

```bash
npx -y @vivswan/maxims config set rule true
npx -y @vivswan/maxims config get rule
npx -y @vivswan/maxims config unset rule
```

A flag on the command line wins over the file for that invocation and leaves the file alone. The two exceptions are `--cooldown` and `--cap`, which write their key as `config set` would and apply at once, because a cap or cooldown typed once is meant for every later sync. `config set` refuses a key the table does not name, with exit 1.

## The cap and the cooldown

Two numbers apply to every source and live in `config.json`, not on a hook command line, so a hook has nothing to drift from. Both flags are maxims-only; `skills` has no analog.

| flag | writes | default | what it governs |
| --- | --- | --- | --- |
| `--cooldown <days>` | `cooldownDays` in `config.json` | 7 | how long `sync` goes without refetching a source; `update` ignores it |
| `--cap <n>` | `ruleCap` in `config.json` | 25 | the most rule lines one source may publish; over it, the whole source is refused with exit 8, never truncated |

The cap is a count, and it is a hard gate. The token estimate printed beside every rule file write is a report and never blocks. The two ways out of exit 8 are named in its hint, narrow with `--memory` or raise `--cap`.

## How a source is fetched

Fetching is anonymous by default. No `gh` login and no token is read unless you pass `--auth`, in which case the token `gh auth token` returns is used for that source on every refresh.

| situation | what runs |
| --- | --- |
| `git` on PATH | a sparse, shallow clone of the memories folder named by `--from`, or of the whole tree under `--full-depth`; never the repository's history |
| `git` missing, GitHub source | one whole-repository tarball download over HTTPS |
| `git` missing, any other git URL | the source is unresolvable, exit 2; a git URL has no tarball fallback |
| the fetch exceeds `MAXIMS_FETCH_TIMEOUT` | treated as a network failure; the [failure paths](state-and-store.md#failure-paths) own what that keeps |

A non-GitHub git URL is stored as you typed it and cloned as you typed it, with no host-specific resolution. The [canonical home](state-and-store.md#the-canonical-home) owns where its store entry lands.

| variable | effect |
| --- | --- |
| `MAXIMS_HOME` | moves the [canonical home](state-and-store.md#the-canonical-home), state, store, and `config.json` with it |
| `GH_HOST` | the GitHub host `@owner/repo` resolves against, for a GitHub Enterprise instance; unset means `github.com` |
| `MAXIMS_FETCH_TIMEOUT` | seconds one fetch may take before it counts as failed |
| `MAXIMS_INSTALL_INTERNAL` | `1` installs memories marked [`metadata.internal`](memory-files.md#the-contract) |

## doctor

`maxims doctor` checks each harness's own loading rules against disk: the rule file at the path the harness reads, required frontmatter present, the hook entry registered, the hook command current. `list` reports what state asks for and re-derives the tier from disk when you run it; `doctor` goes file by file and fails on a mismatch. One line per finding, exit 0 when every harness in state passes.

`--expect <name>` or `--expect @owner/repo/name` asserts that memory has a rule line in place for every harness it targets, and a missing one exits 1 with the harness and path named. `--json` emits the report as one document, so a CI job can assert "these rules are installed" without parsing lines.

```bash
npx -y @vivswan/maxims doctor --expect rubber-duck-before-every-commit --json
```

## init

`maxims init <name>` writes `memories/<name>.md` under the current directory, creating `memories/` if needed, and refuses to overwrite an existing file. The file passes the [memory contract](memory-files.md#the-contract) as written: `name` set, a placeholder `description`, `metadata.node_type: memory`, `metadata.type: feedback`, and `**Why:**` and `**How to apply:**` stubs in the body. Without a name it prompts; non-interactively without one it exits 1.

## Exit codes

| code | meaning | when |
| --- | --- | --- |
| 0 | success, or nothing to do | includes "already up to date" and every `--quiet` outcome |
| 1 | usage error, or a failed check | unknown flag, `-g` with `-o`, ambiguous bare name, a non-interactive `remove` without `--yes`, a `doctor --expect` that is not met |
| 2 | source unresolvable | repo not found, no read access, local directory missing, a non-GitHub git URL with no `git` on PATH |
| 3 | nothing resolved to install | a `--memory` name the source lacks, a filter matching nothing, a source with zero valid memories, a source carrying [hidden characters](memory-files.md#hidden-characters-are-refused) without `--allow-hidden` |
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
non-interactive:  exit 6, nothing written, unless --rename names the pair
result:           two rule lines, two names, one rename entry applied by every later sync
```

`--rename gate-exit-conditions-the-merge=gate-exit-conditions-the-merge-dotfiles` records the same entry the prompt would, so a scripted `add` never meets exit 6 for a collision it knows about.

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

Without a prompt, `add` and `sync` proceed as if `--yes` were given, and `remove` without an explicit `-y` aborts with exit 1; `--all` spells `-y` out, so it is the one form that passes. A collision without `--rename` is exit 6 with nothing written.

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
| none | `--auth`, `--rename`, `--allow-hidden` | maxims-only | anonymous fetch, scripted collision resolution, and the hidden-character gate have no skills concept |
| `add`, `a` | `add`, `a` | same | same alias |
| `update`, `upgrade`, `check` | `update`, `upgrade`, `check` | same | state-driven, no source argument |
| `remove`, `rm`, `r` | `remove`, `rm`, `r` | same | same aliases |
| `use <pkg>@<skill>` | none | diverge | a one-liner is not a workflow you run once without installing |
| `find [query]` | none | diverge | no registry of memory repos exists yet |
| `init [name]` | `init [name]` | same | scaffolds one file in the source layout |
| `list`, `ls` | `list`, `ls` | same | the read command for state |
| `experimental_install`, `i` | `install`, `i` | analog | both replay a committed record into a fresh checkout; maxims reads its own project manifest |
| `experimental_sync` | `sync` | same name | same verb, same instinct |
| none | `doctor`, `link`, `unlink`, `disable`, `enable`, `config` | maxims-only | checking what a harness loads, editing one intent field, and user defaults have no skills concept |
