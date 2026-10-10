---
order: 55
group: Reference
---

# Parity with npx skills

The `maxims` flags and verbs beside their `npx skills` counterparts, with the reason for each divergence. `skills` is the naming authority, so the same concept gets the same flag, short form, and value shape. The flag table is rendered from the parity decisions in `scripts/lib/parity.ts` by `bun run docs:tables`, and a test pins the maxims column against a captured `skills --help` by the same decisions.

## Flags

<!-- BEGIN GENERATED: parity-flags (bun run docs:tables) -->

| npx skills | maxims | parity | why |
|---|---|---|---|
| `-g, --global` | `-g, --global` | same |  |
| `-p, --project` | `-p, --project` | same | `skills` carries it on `update` only; maxims offers it on `add` and `remove` too |
| `-s, --skill <skills>` | `-m, --memory <names>` | analog | only the noun differs; the value shape is copied exactly |
| `-a, --agent <agents>` | `-a, --agent <ids>` | same |  |
| `-l, --list` | `-l, --list` | same |  |
| `-y, --yes` | `-y, --yes` | same |  |
| `--all` | `--all` | same | same shorthand on both verbs |
| `--copy` | `--copy` | same | materialize instead of link |
| `--dry-run` | `--dry-run` | same | `skills` carries it on `experimental_sync` only; maxims accepts it on every verb |
| `--no-cleanup` | none | diverge | a dropped memory leaves on the next sync; an emptied source keeps its [last block](guarantees.md#failure-paths) |
| `--no-remote` | none | diverge | every maxims source is a store entry; `sync --no-fetch` applies them without the network |
| `-r, --recursive` | none | diverge | a workspace's package dependencies have no maxims concept; state lists every source itself |
| `--include <patterns>`, `--exclude <patterns>` | none | diverge | `sync` writes every memory in state; `disable <memory>` withholds one, `-m` narrows an `add` |
| `--full-depth` | `--full-depth` | same | `skills` searches past a root `SKILL.md`; maxims past `memories/` |
| `--json` | `--json` | same | `skills` carries it on `add` and `list`; maxims emits one document from every verb |
| `--metadata <json>` | none | diverge | install telemetry; maxims ships none, see [security](security.md) |
| `--subagent <names>` | none | diverge | a rule file has no subagent scope to target |
| `--owner <owner>` | none | diverge | belongs to `find`, which maxims lacks |
| none | `-o, --out <dir>` | maxims-only | a team's rule file lives in a repo path, not a scope |
| none | `--rule`, `--add-hook`, `--quiet` | maxims-only | skills have no always-loaded layer and no hook that runs unattended |
| none | `--link` | maxims-only | a symlinked store entry for a local source; an open skills request (vercel-labs/skills#748) |
| none | `--cooldown <days>`, `--cap <n>` | maxims-only | the refresh window and the rule budget have no skills concept |
| none | `--auth`, `--rename <upstream>=<local>`, `--allow-hidden` | maxims-only | anonymous fetch, scripted collision resolution, and the hidden-character gate have no skills concept |
| none | `--share` | maxims-only | which sources a project commits is a choice per source; skills have no analog |
| none | `--verbose` | maxims-only | unfolds the `add` and `install` plan to every one-liner; `skills` never folds its summary |
| none | `--from <path>` | maxims-only | names the memories folder; `skills` searches for `SKILL.md`, maxims never autodetects |
| none | `--pin <sha or tag>` | maxims-only | tracks one ref; the captured `skills` page documents none |
| none | `--paths <glob>` | maxims-only | narrows an always-on rule to matching files; a skill already loads [on demand](why.md#the-npx-skills-analogy) |
| none | `--review` | maxims-only | holds an upstream change until `accept`; a skills update applies at once |
| none | `--strict` | maxims-only | the description gate has no skills concept; see [risky shapes](security.md#risky-shapes-in-descriptions) |
| none | `--no-fetch` | maxims-only | `sync` without the network; the nearest skills idea is `--no-remote` above |
| none | `--expect <name or @owner/repo/name>`, `--source <key>` | maxims-only | belong to `doctor` and `show`, which skills lack |

<!-- END GENERATED: parity-flags -->

`-p` on `add` and `remove` exists so `-g` has a visible opposite.

## Verbs

| npx skills | maxims | parity | why |
| --- | --- | --- | --- |
| `add`, `a` | `add`, `a` | same | same alias |
| `update`, `upgrade`, `check` | `update`, `upgrade`, `check` | same | state-driven; an optional source narrows the refresh to one |
| `remove`, `rm`, `r` | `remove`, `rm`, `r` | same | same aliases |
| `use <pkg>@<skill>` | none | diverge | a one-liner is not a workflow you run once without installing |
| `find [query]` | none | diverge | no registry of memory repos exists yet |
| `init [name]` | `init [name]` | same | scaffolds one file in the source layout |
| `list`, `ls` | `list`, `ls` | same | the read command for state |
| `experimental_install`, `i` | `install`, `i` | analog | both replay a committed record into a fresh checkout; maxims reads its own project lock |
| `experimental_sync` | `sync` | same name | same verb, same instinct |
| none | `show`, `doctor`, `lint` | maxims-only | no skills concept covers printing a memory, checking a harness, or linting a folder |
| none | `link`, `unlink`, `disable`, `enable` | maxims-only | editing one intent field has no skills concept |
| none | `config` | maxims-only | user defaults have no skills concept |
| none | `share`, `unshare` | maxims-only | the project lock has no skills concept |
