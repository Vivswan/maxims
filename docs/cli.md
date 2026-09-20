---
order: 50
group: Reference
---

# CLI reference

The lookup page for `npx -y @vivswan/maxims`: every verb, every flag, and every exit code, one row each. The behavior behind the rows lives on the pages the rows link to; this page owns nothing but the table cells.

The npm package is `@vivswan/maxims`; the binary it installs is `maxims`. Command shapes mirror `npx skills`, same flags, same short forms, same prompts, so a person running both never remembers two spellings; the [parity page](parity.md) has the matches and the divergences.

## Verbs

| verb | alias | what it does | network | owner |
| --- | --- | --- | --- | --- |
| `add <source>` | `a` | fetch the source, record its destination, selection, rule flag, and harnesses in state, then sync | yes | [install](install.md) |
| `sync` | | apply state to this machine and project: link bodies, regenerate rule files, reconcile hooks | past the cooldown | [keep fresh](keep-fresh.md#the-session-hook) |
| `update` | `check`, `upgrade` | refetch every source into the store, ignoring the cooldown, then sync | always | [keep fresh](keep-fresh.md#refresh-now-update) |
| `remove <source or name>` | `rm`, `r` | take a source or one memory out of state, then sync | no | [remove](move-or-uninstall.md#remove-a-source-or-a-memory) |
| `list` | `ls` | what state holds per source and per harness, everything past intent re-derived | no | [check](check.md#see-what-is-installed-list) |
| `install` | `i` | replay the project lock: add every source it names at project scope, then sync | yes | [share](share.md#the-project-manifest) |
| `share <source>`, `unshare <source>` | | put a project-scope source into the project lock, or take it out | no | [share](share.md#sharing-a-source) |
| `link <source> -a <harness>` | | add a harness to a source's recorded list without a refetch, then sync | no | below |
| `unlink <source> -a <harness>` | | drop a harness from a source's recorded list, then sync | no | below |
| `disable <memory>` | | keep a memory in state but withhold its rule line and link here, then sync | no | below |
| `enable <memory>` | | undo `disable`, then sync | no | below |
| `doctor` | | report, per harness, whether the rule file and hook are where it loads them | no | [check](check.md#doctor-what-each-harness-loads) |
| `lint [path]` | | check a folder of memory files against the contract before publishing | no | [memories](write-memories.md#lint-a-folder-before-publishing) |
| `config set\|get\|unset <key> [value]` | | read or write a user default | no | [files](files.md#user-defaults-in-configjson) |
| `init [name]` | | scaffold a contract-valid memory file | no | [memories](write-memories.md#scaffold-a-file-with-init) |

- **Two scopes exist,** project (`-p`) and user (`-g`). `-o` is an output folder for a rule file no harness owns, and it is neither scope.
- **No source argument.** `sync`, `update`, `install`, and `doctor` read state or the lock instead.
- **`remove` takes a source or a bare memory name.** A bare name two sources both provide is ambiguous, so `remove` exits 1 and prints the qualified forms.
- **`share` and `unshare` touch the lock only,** never what is installed.
- **`link` and `unlink` change one field,** the source's harness list, and never refetch. `add -a` on an installed source still replaces the whole list, as it replaces the selection.
- **`disable` and `enable` act at one scope,** the one you are in or the one `-g` or `-p` names. A memory disabled at project scope stays live for `-g`, and the other way round; the [state schema](state.md#the-schema) owns where the list is kept.

## Sources

A source is `@owner/repo`, `owner/repo`, a GitHub URL, any other git remote URL (https, http, ssh, git, or the `git@host:path` form), or a local directory. `.` installs the current working tree as a live source.

The `@` in `@owner/repo` is cosmetic, as it is for `skills`.

| source form | what it means |
| --- | --- |
| `@owner/repo@memory-name` | the same as `@owner/repo -m memory-name`: one memory, by name |
| `https://github.com/owner/repo/tree/<ref>` | a GitHub URL whose `/tree/<ref>` segment sets the ref, as `--pin <ref>` would |
| `https://git.example.com/team/rules.git`, `git@host:path` | any git remote, stored verbatim; [how a source is fetched](keep-fresh.md#how-a-source-is-fetched) |

A path after the `/tree/<ref>` segment is refused, because a branch containing `/` cannot be told from the path. Drop the `/tree/` tail and pass the ref with `--pin` and the path with `--from`.

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
| `-g, --global` | add, remove, disable, enable | auto | the user scope; [where it lands](install.md#where-it-lands) |
| `-p, --project` | add, remove, disable, enable | auto | the project scope; [where it lands](install.md#where-it-lands) |
| `-o, --out <dir>` | add, remove | off | an output folder instead of a scope; [where it lands](install.md#where-it-lands) |
| `-m, --memory <names>` | add, remove | `*` | only these memories; [what gets installed](install.md#what-gets-installed) |
| `-a, --agent <ids>` | add, remove, sync, update, link, unlink | detected | target harnesses, ids from the [matrix](harnesses.md#the-matrix); each verb reads it differently, see below |
| `-l, --list` | add | off | preview the source, write nothing; [what gets installed](install.md#what-gets-installed) |
| `-y, --yes` | add, remove | auto | skip the confirmation prompt; [non-interactive behavior](install.md#non-interactive-behavior) |
| `--all` | add, remove | off | every memory, every harness, no prompt; [what gets installed](install.md#what-gets-installed) |
| `--rule` | add | off | publish one-liners into the rule file; [two separate choices](install.md#two-separate-choices) |
| `--add-hook` | add | off | register the harness's sync hook; [two separate choices](install.md#two-separate-choices) |
| `--share` | add | off | record the source in the [project lock](share.md#the-project-manifest) as well as in state |
| `--copy` | add | off | copy bodies instead of linking them; [bodies](install.md#bodies) |
| `--link` | add | off, on for `.` | local sources: link the store to the directory; [bodies](install.md#bodies) |
| `--from <path>` | add | `memories/` | the folder in the source holding memories; [source layout](write-memories.md#layout-in-a-source) |
| `--full-depth` | add, lint | off | scan the whole source; [source layout](write-memories.md#layout-in-a-source) |
| `--pin <sha or tag>` | add | off | track this ref; [refs](install.md#refs) |
| `--paths <glob>` | add | off | scope the rules to matching files, repeatable; [path scoping](install.md#path-scoping) |
| `--rename <upstream>=<local>` | add | off | resolve a name collision, repeatable; [collisions](install.md#name-collisions-and-renames) |
| `--allow-hidden` | add | off | accept descriptions carrying [hidden characters](write-memories.md#hidden-characters-are-refused) |
| `--auth` | add | off | fetch with your `gh` login; [fetching](keep-fresh.md#how-a-source-is-fetched) |
| `--no-fetch` | sync | off | never touch the network; [fetching](keep-fresh.md#how-a-source-is-fetched) |
| `--cooldown <days>` | add, sync, update | 7 | days between refreshes, saved to `config.json`; [the cap and the cooldown](keep-fresh.md#the-cap-and-the-cooldown) |
| `--cap <n>` | add, sync, update, lint | 25 | most rule lines per source, saved to `config.json`; [the cap and the cooldown](keep-fresh.md#the-cap-and-the-cooldown) |
| `--expect <name or @owner/repo/name>` | doctor | off | assert this memory has a rule line, repeatable; [the CI one-liner](check.md#the-ci-one-liner) |

- **`-a` on `sync`** limits the run to the named harnesses and fetches nothing; `-a '*'` names them all and fetches as a plain `sync` does.
- **`-a` on `update`** still refreshes every source, and a refreshed source is written for every harness that reads it; the filter narrows only the untouched sources.
- **`-a` on `remove`** drops those harnesses from a whole source and is refused on a memory.

On `lint`, `--cap` is a threshold for this run only and persists nothing; the [lint section](write-memories.md#lint-a-folder-before-publishing) owns it.

Flags compose. The everyday invocation, `add @Vivswan/skills -g --rule --add-hook`, is the [quickstart](quickstart.md#install-a-source).

## Exit codes

| code | meaning |
| --- | --- |
| 0 | success, or nothing to do |
| 1 | usage error, or a failed check |
| 2 | source unresolvable |
| 3 | nothing resolved to install |
| 4 | destination write failed |
| 5 | store locked |
| 6 | name collision |
| 7 | unmet dependency |
| 8 | rule cap exceeded |

- **Exit 0** includes "already up to date" and every `--quiet` outcome.
- **Exit 1** follows an unknown flag, `-g` with `-o`, an ambiguous bare name, a non-interactive `remove` without `--yes`, or a `doctor --expect` that is not met.
- **Exit 2** follows a repo not found, no read access, a missing local directory, a non-GitHub git URL with no `git` on PATH, or an interactive `sync` whose fetch failed.
- **Exit 3** follows a `--memory` name the source lacks, a filter matching nothing, a source with zero valid memories, a source carrying [hidden characters](write-memories.md#hidden-characters-are-refused) without `--allow-hidden`, or a `lint` that found problems.
- **Exit 4** follows permissions, a read-only filesystem, a full disk, or an unparsable harness config.
- **Exit 5** means another maxims process held the lock past the wait.
- **Exit 6** means an incoming memory's name is owned by another source and no rename was chosen.
- **Exit 7** means a `[[wikilink]]` target does not resolve.
- **Exit 8** means the source's rule-flagged set is over the cap, or a rule file is over the harness's byte budget.

Codes 3, 6, 7, and 8 are one family. The install would be incomplete, so nothing at all is written; a partial install is a set of rules the user believes is loaded and is not.

`--quiet` collapses every non-zero code to 0 after logging. This is a requirement, not an optimization. A harness shows a failing hook to the user at every session start, and fail-soft is what keeps that notice from becoming permanent.
