---
order: 53
group: Reference
---

# State

One file in the [maxims home](files.md#the-canonical-home), `state.json`, records what should be installed. `sync` reads that file and makes the machine match; nothing else on disk is ever read back as a record of what maxims did.

This page owns what belongs in the file, the schema, and migrations. The [guarantees page](guarantees.md) owns what happens when a run fails, and the [share page](share.md) owns the file a project commits.

## State holds intent, never actuality

Each fact has exactly one owner. State records only what nothing else on the machine can tell you.

| category | what belongs | example |
| --- | --- | --- |
| user intent | what the user asked for | which source, which memories, whether it publishes rule lines, which harnesses, where |
| fetch facts | what the last fetch found | the sha, when, the content hashes, the last error |
| provenance | when it was added and which maxims wrote the file | `addedAt`, `writtenBy` |

| not in state | the real owner |
| --- | --- |
| whether a memory is in the rule file | derived at sync from the rule flag, the selection, the renames, and the cap |
| installed paths and store paths | derived from the destination and the store's naming scheme |
| whether the hook is registered, its command, whether it is async | the harness registry, read at sync; a maxims upgrade that changes the command needs no migration, the next sync rewrites it |
| each target's path, strategy, and tier | the harness definition for the first two; the tier achieved is a sync-time result `list` reports |
| collisions | re-derived by walking the name index; a resolution is a rename entry |
| retired memories | the log; a retired memory drops out of the regenerated block on its own |
| `updatedAt` | the state file's mtime, plus the log |
| user defaults: which harnesses, `--yes`, `--rule`, `--add-hook`, the cooldown, the cap | `config.json`, beside state; `sync` reads the cooldown and the cap from it, and every other key fills in a flag on `add`, whose result is ordinary intent |
| the project's source list for a fresh clone | the [project lock](share.md) in the project; state is per machine and the lock is per repository |

Storing "it is installed" beside "it should be installed" creates two fields that can disagree the moment a user hand-edits a settings file. With no actuality fields there is nothing to reconcile, and recovery from any crash is `maxims sync` again.

## The schema

```json
{
  "version": 1,
  "writtenBy": "maxims@0.4.1",
  "hooks": ["claude-code", "codex"],
  "sources": {
    "@Vivswan/skills": {
      "intent": {
        "from": { "type": "github", "repo": "Vivswan/skills", "ref": "HEAD" },
        "auth": false,
        "select": ["gate-exit-conditions-the-merge", "rubber-duck-before-every-commit"],
        "rename": { "gate-exit-conditions-the-merge": "gate-exit-conditions-the-merge-dotfiles" },
        "rule": true,
        "destination": { "scope": "global" },
        "copy": false,
        "harnesses": ["claude-code", "codex"],
        "memoryPath": "memories",
        "fullDepth": false
      },
      "fetched": {
        "at": "2026-08-27T04:12:09.113Z",
        "sha": "fc675572711b0a1c9e00000000000000000000aa",
        "memoryPath": "memories",
        "memories": {
          "rubber-duck-before-every-commit": {
            "content": "sha256:9f2a1c9f2a1c9f2a1c9f2a1c9f2a1c9f2a1c9f2a1c9f2a1c9f2a1c9f2a1c9f2a",
            "description": "sha256:11cd11cd11cd11cd11cd11cd11cd11cd11cd11cd11cd11cd11cd11cd11cd11cd"
          }
        },
        "lastError": null
      },
      "addedAt": "2026-08-20T08:38:04.471Z"
    }
  },
  "disabled": {
    "global": ["gate-exit-conditions-the-merge-dotfiles"],
    "project": { "/home/user/project": ["rubber-duck-before-every-commit"] }
  }
}
```

The example is hand-written and parses against the current schema; a test keeps it that way.

| field | why it exists |
| --- | --- |
| `version` | integer schema version, bumped on any breaking shape change |
| `writtenBy` | which maxims wrote this, so a bug report is reproducible without asking |
| `hooks` | the harnesses where the user wants a sync hook kept: a list, not records |
| `overrides` | reserved for the one hook fact that is intent, a config path the user chose over the harness definition; accepted as an open record, and nothing writes or reads it yet |
| `intent.from` | `github` with `repo`, `ref`, and `host` only when `GH_HOST` named an enterprise instance at `add` time, so the source is never re-expanded against `github.com` later; `git` with the remote `url` as you typed it and `ref`; or `local` with `path` and optional `live`. A pinned local directory or a live fetched source cannot be written down. `HEAD` means the default branch's head; the branch name is never stored because a repo can rename it. |
| `intent.auth` | whether refreshes of this source use your `gh` login; set by `--auth`, false by default, so an anonymous install never turns authenticated on its own |
| `intent.select` | `*` or an explicit list; applied every sync, so a refresh can never widen the selection |
| `intent.rename` | upstream name to local name; why it exists is not stored, `list` re-derives whether it still resolves a live collision |
| `intent.rule` | whether this source publishes one-liners; the field that separates `--rule` from `--add-hook` |
| `intent.destination` | `global`; `project` with the project's absolute `root`, so `sync` and `list` find a project's sources from state alone and a moved folder shows as a root that no longer exists; or `out` with a `path`. `-g` with `-o` has no representation |
| `intent.copy`, `intent.memoryPath`, `intent.fullDepth`, `intent.paths` | `--copy`, `--from`, `--full-depth`, `--paths`, recorded per source |
| `intent.harnesses` | which harnesses this source writes to |
| `fetched.at`, `fetched.sha` | drive the cooldown and staleness; the sha is what was fetched, where `ref` is what was asked for: the 40-hex commit sha the remote reported for a GitHub or git source, or a `sha256:<64 hex>` hash of the directory contents for a copied local source, spelled like a memory hash. A live local source has no `fetched` block, because the tree is the record. |
| `fetched.memories` | a content hash and a description hash per memory, so a body-only edit skips the rule rewrite |
| `fetched.lastError` | why the last fetch failed (`network`, `ratelimit`, `missing`, `auth`, `invalid`), so the staleness notice can say which |
| `addedAt` | provenance; there is no `updatedAt` |
| `disabled` | the memories `disable` withheld, by local name: `global` is one sorted list for `-g`, `project` one sorted list per project root, so a memory disabled in one project stays live everywhere else; the [project lock](share.md#the-project-manifest) carries a copy of its own root's list |

Status: `destination.root` is specified, not yet in the schema; it lands with `--share`, whose status the [sharing section](share.md#sharing-a-source) tracks.

Each source is keyed by what identifies it, never by a memory name, which is what makes an upstream rename disappear cleanly. The block is regenerated from the store's current content, so a vanished name cannot survive in the output.

| source | key | note |
| --- | --- | --- |
| GitHub | `@owner/repo`, or `@<host>/owner/repo` on a GitHub Enterprise host | the key keeps the case you typed, but GitHub names are case-insensitive and the store folds them, so two keys whose `owner/repo` differ only by letter case are corrupt and the file is refused; a `#<ref>` suffix is compared as typed |
| any other git remote | the URL as you typed it | never rewritten |
| local directory | its absolute path | |
| any pinned source | the key above plus `#<ref>` | `@acme/rules` and `@acme/rules#v2` are two sources and may both be installed |

## Migrations

State migrates forward only.

| `version` in the file | what happens |
| --- | --- |
| below the current one | the ordered steps run, each a pure function over the JSON, then the file is written back atomically and the command continues |
| above the current one | a clean stop: in quiet mode exit 0 with "state written by a newer maxims, skipping", otherwise a request to upgrade, because a rewrite would destroy fields the older binary cannot see |

| rule | reason |
| --- | --- |
| each step is named for the version it migrates away from | a step is authored against the shipped shape, with no guess at the next release number |
| steps chain in ascending order and each is idempotent | an update can be retried, so a step may run twice |
| one golden fixture per step | the shape change is proven, not described |
| steps are deleted once a hard break makes them unreachable | the migration directory is not allowed to accumulate compatibility baggage |
| downgrading past a migration is unsupported | recovery is the same as corruption: quarantine and re-add |

A corrupt state file is moved aside to `state.json.corrupt-<timestamp>` and the user is told to re-add; a dry run or a read-only verb never moves it. It is not rebuilt from the rule files, because no reading of a managed block reveals which memories the user selected or whether they asked for rule lines.

Only intent-shape changes ever need a migration; everything derived is regenerated by the next sync at the current spec.
