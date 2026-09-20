---
order: 55
group: Reference
---

# Parity with npx skills

The `maxims` flags and verbs beside their `npx skills` counterparts, with the reason for each divergence. `skills` is the naming authority, so the same concept gets the same flag, short form, and value shape. The specified guard is a test that pins the maxims column against a captured `skills --help`.

## Flags

| npx skills | maxims | parity | why |
| --- | --- | --- | --- |
| `-g, --global` | `-g, --global` | same | |
| `-p, --project` | `-p, --project` | same | `skills` carries it on `update` only; maxims offers it on `add` and `remove` too |
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
| none | `--link` | maxims-only | a symlinked store entry for a local source; an open skills request (vercel-labs/skills#748) |
| none | `--cooldown`, `--cap` | maxims-only | the refresh window and the rule budget have no skills concept |
| none | `--auth`, `--rename`, `--allow-hidden` | maxims-only | anonymous fetch, scripted collision resolution, and the hidden-character gate have no skills concept |
| none | `--share` | maxims-only | which sources a project commits is a choice per source; skills have no analog |

`-p` on `add` and `remove` exists so `-g` has a visible opposite.

## Verbs

| npx skills | maxims | parity | why |
| --- | --- | --- | --- |
| `add`, `a` | `add`, `a` | same | same alias |
| `update`, `upgrade`, `check` | `update`, `upgrade`, `check` | same | state-driven, no source argument |
| `remove`, `rm`, `r` | `remove`, `rm`, `r` | same | same aliases |
| `use <pkg>@<skill>` | none | diverge | a one-liner is not a workflow you run once without installing |
| `find [query]` | none | diverge | no registry of memory repos exists yet |
| `init [name]` | `init [name]` | same | scaffolds one file in the source layout |
| `list`, `ls` | `list`, `ls` | same | the read command for state |
| `experimental_install`, `i` | `install`, `i` | analog | both replay a committed record into a fresh checkout; maxims reads its own project lock |
| `experimental_sync` | `sync` | same name | same verb, same instinct |
| none | `doctor`, `lint` | maxims-only | checking what a harness loads and linting a source folder have no skills concept |
| none | `link`, `unlink`, `disable`, `enable` | maxims-only | editing one intent field has no skills concept |
| none | `config` | maxims-only | user defaults have no skills concept |
| none | `share`, `unshare` | maxims-only | the project lock has no skills concept |
