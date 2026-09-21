---
order: 44
group: Guides
---

# Check an install

Two verbs that never write into a harness: `list` reports what state asks for, and `doctor` checks what each harness will load against the files on disk. The [quickstart](quickstart.md) is the install path these verbs check.

## See what is installed: list

```bash
npx -y @vivswan/maxims list
```

The specification fixes what `list` reports and leaves the layout to mirror `npx skills list`: a "Global Memories" or "Project Memories" header, then one row per memory with its path and an indented line naming the agents and the source. Everything past the recorded intent is re-derived when you run it, so a hand-edited hook registry is reported as it is, not as it was.

| `list` reports | derived from |
| --- | --- |
| each source, its selected memories, the fetched sha and each memory's short content hash | state |
| staleness per source, with the reason of the last failed fetch | state |
| a reviewed source's mark, and the revision [held for review](keep-fresh.md#hold-changes-for-review) with its changed-line count | state |
| live name collisions and the renames resolving them | the name index, rebuilt from every source's intent |
| the tier each harness achieves, and the rule file token estimate | the harness configs and rule files on disk |

## doctor: what each harness loads

```bash
npx -y @vivswan/maxims doctor
```

`doctor` reads each harness's own loading rules against disk: the rule file at the path the harness reads, required frontmatter present, the hook entry registered, the hook command current. `list` reports what state asks for and re-derives the tier from disk when you run it; `doctor` goes file by file and fails on a mismatch. It prints one line per finding.

| line starts with | meaning |
| --- | --- |
| `ok` | this harness loads what state asks for |
| `!` | a warning: an undefined harness id, a [held revision](keep-fresh.md#hold-changes-for-review), or "never synced" |
| `x` | one harness that will not load a rule you believe is installed |

The report ends with a `Defaults:` line naming the `rule` and `addHook` defaults from `config.json`, and with the age of the last sync. Exit 0 when every harness in state passes, exit 1 when any line is `x`.

## The CI one-liner

```bash
npx -y @vivswan/maxims doctor --expect rubber-duck-before-every-commit --json
```

`--expect <name>` or `--expect @owner/repo/name` asserts that memory has a rule line in place for every harness it targets. A missing one exits 1 with the harness and path named. The flag repeats, one memory per `--expect`.

`--json` emits the report as one document, so a CI job asserts "these rules are installed" without parsing lines. Its top-level keys are `ok`, `findings`, `harnesses`, `unresolved`, `expect`, `lastSync`, and `defaults`. `findings` carries the printed lines as `{ "kind": "ok" | "warn" | "fail", "text" }`, and `ok` is false when any finding is `fail`, the `x` lines above.
