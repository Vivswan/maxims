---
order: 40
group: Reference
---

# Memory files

A memory is one markdown file holding one rule: YAML frontmatter with a `name` and a one-line `description`, then a body with the why and the how. maxims reads the format Claude Code's auto-memory already writes, unchanged, so a file that works there is a memory here without edits.

## A complete example

```markdown
---
name: gate-exit-conditions-the-merge
description: "Never chain a merge or push in the same compound command as reading a gate log; condition the merge on the gate's exit code, in a separate command after the result is read"
metadata:
  node_type: memory
  type: feedback
  scope: common
---

A landing merge is a SEPARATE command issued only after the gate's exit code is read and is zero.

**Why:** 2026-08-23. A background gate chain merged before its own log was read.
**How to apply:** Two commands minimum. Sibling trap to [[no-pipe-masked-exit-codes]].
```

The `description` is the one-liner that reaches the rule file. Everything below the frontmatter stays in this file on disk, behind the pointer at the end of the rule line.

## The contract

| field | required | rule |
| --- | --- | --- |
| `name` | yes | kebab-case, `[a-z0-9]+(-[a-z0-9]+)*`, at most 200 characters, equal to the filename stem; it is the identity everywhere |
| `description` | yes | non-empty, one line after YAML unquoting; this is the one-liner that reaches the rule file |
| `metadata.node_type` | no | `memory` when present; absent is accepted |
| `metadata.type` | no | `user`, `feedback`, `project`, or `reference`; an unknown value passes with a warning |
| `metadata.internal` | no | `true` hides the memory from every `add` and refresh unless `MAXIMS_INSTALL_INTERNAL=1` is set, for a source repo's own maintainers; absent or `false` is a normal memory |
| `metadata.scope`, any other key | no | carried in the store, never interpreted |
| body | no | may be empty; `**Why:**` and `**How to apply:**` are conventions maxims preserves verbatim and never parses; `[[links]]` are preserved too, and resolved as dependencies (below) |

A file that fails the contract is skipped with one warning line, never fatally. A source repo that gains a README must not break every session's hook.

`MEMORY.md` is reserved and is never a memory. It is the index the auto-memory format keeps beside its files, and it is skipped by name.

## Hidden characters are refused

A memory carrying a character the reader cannot see fails the whole install, because the plan shown at `add` is the review gate and a hidden instruction passes it unseen. The check runs over the whole file, frontmatter and body.

| refused | why |
| --- | --- |
| zero-width characters (`U+200B` to `U+200D`, `U+2060`, `U+FEFF`) | invisible in a terminal, so a one-liner can differ from what the plan showed |
| bidi control characters (`U+061C`, `U+200E`, `U+200F`, `U+202A` to `U+202E`, `U+2066` to `U+2069`) | reorder what a reader sees, so displayed text and stored text disagree |
| control characters (`U+0000` to `U+001F` except tab, `U+007F` to `U+009F`) | a terminal prints nothing for them, or moves the cursor, so the file and its display disagree |
| ANSI escape sequences | a terminal executes them while printing the plan |
| HTML comments | invisible in a rendered rule file, and the block markers are HTML comments |

The refusal is exit 3, nothing written, with the file and the character named. `--allow-hidden` on `add` installs the source anyway; the [flag table](cli.md#flags) owns it. Unlike a contract failure, this is not a per-file skip, because an unseen instruction is the failure the gate exists to catch.

## Wikilinks are dependencies

A `[[name]]` in the body names another memory this rule depends on. `add` requires every link target to resolve, either inside the same install or among memories already installed. A dangling link aborts the add and names the unmet dependency, with [exit 7](cli.md#exit-codes), the way a package manager refuses a missing dependency.

Resolution runs through the rename map, so a memory renamed locally after a [name collision](cli.md#name-collisions-and-renames) still satisfies links written against its upstream name. The file content is never rewritten to match.

## Layout in a source

```text
<source root>/
`-- memories/
    |-- gate-exit-conditions-the-merge.md
    |-- rubber-duck-before-every-commit.md
    `-- MEMORY.md                          # reserved, skipped
```

The reference source `@Vivswan/skills` uses this layout, a `memories/` directory at the repo root beside its skills, so one repo and one review gate carry both.

| flag on `add` | what it reads |
| --- | --- |
| none | `memories/` at the source root |
| `--from <path>` | the folder you name instead; recorded in state so every later sync reads the same folder |
| `--full-depth` | the whole source tree, not stopping at the memories folder; the companion to `--from` for an unusual layout |

Autodetecting memories by frontmatter is not attempted, because any README with a `name:` field would become a rule. You name the folder; the tool never guesses.

## Scaffolding a new file

`maxims init <name>` writes a contract-valid file at `memories/<name>.md` for you to fill in. The [cli page](cli.md#init) owns what it writes and when it refuses.
