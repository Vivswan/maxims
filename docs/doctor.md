---
order: 56
group: Reference
---

# Checking an install: doctor, lint, init

Three verbs that never write into a harness: `doctor` checks what each harness will load, `lint` checks a folder of memory files before you publish it, and `init` scaffolds one file. The [quickstart](quickstart.md) is the install path these verbs check.

## doctor

```bash
npx -y @vivswan/maxims doctor
```

`doctor` reads each harness's own loading rules against disk: the rule file at the path the harness reads, required frontmatter present, the hook entry registered, the hook command current. `list` reports what state asks for and re-derives the tier from disk when you run it; `doctor` goes file by file and fails on a mismatch. It prints one line per finding.

| line starts with | meaning |
| --- | --- |
| `ok` | this harness loads what state asks for |
| `!` | a warning: a harness id state names that no definition answers to, or "never synced" |
| `x` | one harness that will not load a rule you believe is installed |

The report ends with a `Defaults:` line naming the `rule` and `addHook` defaults from `config.json`, and with the age of the last sync. Exit 0 when every harness in state passes, exit 1 when any line is `x`.

## The CI one-liner

```bash
npx -y @vivswan/maxims doctor --expect rubber-duck-before-every-commit --json
```

`--expect <name>` or `--expect @owner/repo/name` asserts that memory has a rule line in place for every harness it targets. A missing one exits 1 with the harness and path named. The flag repeats, one memory per `--expect`.

`--json` emits the report as one document, so a CI job asserts "these rules are installed" without parsing lines. Its top-level keys are `ok`, `harnesses`, `unresolved`, `expect`, `lastSync`, and `defaults`.

## lint

```bash
npx -y @vivswan/maxims lint            # checks memories/ under the current directory
npx -y @vivswan/maxims lint path/to/folder --full-depth --cap 30
```

`lint` is the source repo's check. It reads every `.md` in the folder and prints one `path:line: reason` per problem, so an editor can jump to it.

| check | problem it reports |
| --- | --- |
| the [contract](memory-files.md#the-contract) | a file that would be skipped at `add`, with the contract's reason; a `metadata.type` warning counts |
| [hidden characters](memory-files.md#hidden-characters-are-refused) | a `description` carrying one, with its code point and column |
| [wikilinks](memory-files.md#wikilinks-are-dependencies) | a `[[link]]` that names no memory in this folder |
| the [rule cap](fetching.md#the-cap-and-the-cooldown) | more memories than the cap allows; `--cap <n>` sets the threshold for this run only and persists nothing |

| outcome | exit |
| --- | --- |
| no problems | 0 |
| any problem | 3, the same code an incomplete install gets |
| a folder or file that cannot be read | 1; "no problems" is a claim about files that were inspected |

`--full-depth` scans subfolders too. `--json` prints `{ "ok": true, "problems": [] }` with one object per problem instead of the lines.

## init

```bash
npx -y @vivswan/maxims init gate-exit-conditions-the-merge
```

`init <name>` writes `memories/<name>.md` under the current directory, creating `memories/` if needed, and refuses to overwrite an existing file. Without a name it prompts; non-interactively without one it exits 1.

The file passes the [memory contract](memory-files.md#the-contract) as written:

| field | value |
| --- | --- |
| `name` | the name you gave |
| `description` | a placeholder for you to replace |
| `metadata.node_type` | `memory` |
| `metadata.type` | `feedback` |
| body | `**Why:**` and `**How to apply:**` stubs |
