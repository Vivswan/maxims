---
order: 50
group: Reference
---

# CLI reference

The lookup page for `npx -y @vivswan/maxims`: every verb, every flag, and every exit code, one row each. The behavior behind the rows lives on the pages the rows link to; this page owns nothing but the table cells.

The npm package is `@vivswan/maxims`; the binary it installs is `maxims`. Command shapes mirror `npx skills`, same flags, same short forms, same prompts, so a person running both never remembers two spellings; the [parity page](parity.md) has the matches and the divergences.

## Verbs

| verb | alias | what it does | touches the network |
| --- | --- | --- | --- |
| `add <source>` | `a` | fetch the source, record it in state (destination, selection, rule flag, harnesses), then run an initial sync; the [installing page](installing.md) owns it | yes |
| `sync` | | apply state to this machine and project: link bodies, regenerate rule files, reconcile hooks | only for a source past its cooldown |
| `update` | `check`, `upgrade` | refetch every source into the store, ignoring the cooldown, then sync | always |
| `remove <source or name>` | `rm`, `r` | take a source or one memory out of state, then sync | no |
| `list` | `ls` | what state holds, per source and per harness, with everything past intent re-derived on the spot | no |
| `install` | `i` | replay the [project lock](project-lock.md#the-project-manifest): add every source it names at project scope, then sync | yes |
| `share <source>`, `unshare <source>` | | put a project-scope source into the project lock, or take it out, without touching what is installed | no |
| `link <source> -a <harness>` | | add a harness to a source's recorded list without a refetch, then sync | no |
| `unlink <source> -a <harness>` | | drop a harness from a source's recorded list, then sync | no |
| `disable <memory>` | | keep a memory in state but withhold its rule line and link at this scope, then sync | no |
| `enable <memory>` | | undo `disable`, then sync | no |
| `doctor` | | report, per harness, whether the rule file and hook are where the harness loads them; the [doctor page](doctor.md#doctor) owns it | no |
| `lint [path]` | | check a folder of memory files against the contract before you publish it; the [doctor page](doctor.md#lint) owns it | no |
| `config set\|get\|unset <key> [value]` | | read or write a [user default](fetching.md#user-defaults-in-configjson) | no |
| `init [name]` | | scaffold a contract-valid memory file; the [doctor page](doctor.md#init) owns it | no |

Status: `share`, `unshare`, and `config` are specified, not yet built.

- **Two scopes exist,** project (`-p`) and user (`-g`). `-o` is an output folder for a rule file no harness owns, and it is neither scope.
- **No source argument.** `sync`, `update`, `install`, and `doctor` read state or the lock instead.
- **`remove` takes a source or a bare memory name.** A bare name two sources both provide is ambiguous, so `remove` exits 1 and prints the qualified forms.
- **`link` and `unlink` change one field,** the source's harness list, and never refetch. `add -a` on an installed source still replaces the whole list, as it replaces the selection.
- **`disable` and `enable` act at one scope,** the one you are in or the one `-g` or `-p` names. A memory disabled at project scope stays live for `-g`, and the other way round; the [state schema](state.md#the-schema) owns where the list is kept.

## Sources

A source is `@owner/repo`, `owner/repo`, a GitHub URL, any other git remote URL (https, http, ssh, git, or the `git@host:path` form), or a local directory. `.` installs the current working tree as a live source. The `@` in `@owner/repo` is cosmetic, as it is for `skills`.

| source form | what it means |
| --- | --- |
| `@owner/repo@memory-name` | the same as `@owner/repo -m memory-name`: one memory, by name |
| `https://github.com/owner/repo/tree/<ref>` | a GitHub URL whose `/tree/<ref>` segment sets the ref, as `--pin <ref>` would. A path after the ref is refused, because a branch containing `/` cannot be told from the path; drop the `/tree/` tail and pass the ref with `--pin` and the path with `--from` |
| `https://git.example.com/team/rules.git`, `git@host:path` | any git remote, stored verbatim; the [fetching page](fetching.md#how-a-source-is-fetched) owns what happens to it |

## Flags

These flags work on every verb.

| flag | default | what it does |
| --- | --- | --- |
| `--dry-run` | off | prints the exact plan and diff, writes nothing, exit 0 |
| `--json` | off | the same plan as one JSON document, for CI assertions |
| `--quiet` | off | one-line output and fail-soft, see the exit codes below; the hook's mode |
| `--verbose` | off | adds fetch details to the output |
| `-h, --help`, `-v, --version` | | standard |

The rest belong to the verbs the second column names. A value flag takes `--flag value` or `--flag=value`. A list flag takes a comma list and may repeat, so `-m a,b -m c` selects three memories.

| flag | verbs | default | meaning |
| --- | --- | --- | --- |
| `-g, --global` | add, remove, disable, enable | auto | the user scope; [where it lands](installing.md#where-it-lands) |
| `-p, --project` | add, remove, disable, enable | auto | the project scope; [where it lands](installing.md#where-it-lands) |
| `-o, --out <dir>` | add, remove | off | an output folder instead of a scope; [where it lands](installing.md#where-it-lands) |
| `-m, --memory <names>` | add, remove | `*` | only these memories; [what gets installed](installing.md#what-gets-installed) |
| `-a, --agent <ids>` | add, remove, sync, update, link, unlink | detected | target harnesses, ids from the [matrix](harnesses.md#the-matrix); on `sync` and `update`, limits the run to those harnesses |
| `-l, --list` | add | off | preview the source, write nothing; [what gets installed](installing.md#what-gets-installed) |
| `-y, --yes` | add, remove | auto | skip the confirmation prompt; [non-interactive behavior](installing.md#non-interactive-behavior) |
| `--all` | add, remove | off | every memory, every harness, no prompt; [what gets installed](installing.md#what-gets-installed) |
| `--rule` | add | off | publish one-liners into the rule file; [two separate choices](installing.md#two-separate-choices) |
| `--add-hook` | add | off | register the harness's sync hook; [two separate choices](installing.md#two-separate-choices) |
| `--share` | add | off | record the source in the [project lock](project-lock.md#the-project-manifest) as well as in state |
| `--copy` | add | off | copy bodies instead of linking them; [bodies](installing.md#bodies) |
| `--link` | add | off, on for `.` | local sources: link the store to the directory; [bodies](installing.md#bodies) |
| `--from <path>` | add | `memories/` | the folder in the source holding memories; [source layout](memory-files.md#layout-in-a-source) |
| `--full-depth` | add, lint | off | scan the whole source; [source layout](memory-files.md#layout-in-a-source) |
| `--pin <sha or tag>` | add | off | track this ref; [refs](installing.md#refs) |
| `--paths <glob>` | add | off | scope the rules to matching files, repeatable; [path scoping](installing.md#path-scoping) |
| `--rename <upstream>=<local>` | add | off | resolve a name collision, repeatable; [collisions](installing.md#name-collisions-and-renames) |
| `--allow-hidden` | add | off | accept descriptions carrying [hidden characters](memory-files.md#hidden-characters-are-refused) |
| `--auth` | add | off | fetch with your `gh` login; [fetching](fetching.md#how-a-source-is-fetched) |
| `--no-fetch` | sync | off | never touch the network; [fetching](fetching.md#how-a-source-is-fetched) |
| `--cooldown <days>` | add, sync, update | 7 | days between refreshes, saved to `config.json`; [the cap and the cooldown](fetching.md#the-cap-and-the-cooldown) |
| `--cap <n>` | add, sync, update, lint | 25 | most rule lines per source, saved to `config.json`; [the cap and the cooldown](fetching.md#the-cap-and-the-cooldown). On `lint`, a threshold for this run only; [lint](doctor.md#lint) |
| `--expect <name or @owner/repo/name>` | doctor | off | assert this memory has a rule line, repeatable; [the CI one-liner](doctor.md#the-ci-one-liner) |

Flags compose. The everyday invocation, `add @Vivswan/skills -g --rule --add-hook`, is the [quickstart](quickstart.md#install-a-source).

## Exit codes

| code | meaning | when |
| --- | --- | --- |
| 0 | success, or nothing to do | includes "already up to date" and every `--quiet` outcome |
| 1 | usage error, or a failed check | unknown flag, `-g` with `-o`, ambiguous bare name, a non-interactive `remove` without `--yes`, a `doctor --expect` that is not met |
| 2 | source unresolvable | repo not found, no read access, local directory missing, a non-GitHub git URL with no `git` on PATH, an interactive `sync` whose fetch failed |
| 3 | nothing resolved to install | a `--memory` name the source lacks, a filter matching nothing, a source with zero valid memories, a source carrying [hidden characters](memory-files.md#hidden-characters-are-refused) without `--allow-hidden`, a `lint` that found problems |
| 4 | destination write failed | permissions, read-only filesystem, disk full, an unparsable harness config |
| 5 | store locked | another maxims process held the lock past the wait |
| 6 | name collision | an incoming memory's name is owned by another source and no rename was chosen |
| 7 | unmet dependency | a `[[wikilink]]` target does not resolve |
| 8 | rule cap exceeded | the source's rule-flagged set is over the cap, or a rule file is over the harness's byte budget |

Codes 3, 6, 7, and 8 are one family. The install would be incomplete, so nothing at all is written; a partial install is a set of rules the user believes is loaded and is not.

`--quiet` collapses every non-zero code to 0 after logging. This is a requirement, not an optimization. A harness shows a failing hook to the user at every session start, and fail-soft is what keeps that notice from becoming permanent.
