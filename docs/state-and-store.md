---
order: 70
group: Reference
---

# State and store

Everything maxims owns lives under one directory, and one file in it, `state.json`, records what should be installed. `sync` reads that file and makes the machine match; nothing else on disk is ever read back as a record of what maxims did.

## The canonical home

```text
~/.agents/maxims/                       # or $MAXIMS_HOME
|-- store/
|   |-- vivswan/skills/                 # a GitHub source: store/<owner>/<repo>, lower-cased
|   |   |-- rubber-duck-before-every-commit.md
|   |   `-- ...
|   |-- vivswan/skills@v2-fb04dcb6/     # the same repo pinned: <repo>@<ref, unsafe characters folded to -, cut at 40>-<8 hex of the ref>; a separate source
|   |-- _github/ghe.example.com/acme/rules/ # a GitHub Enterprise source: _github/<host>/<owner>/<repo>
|   |-- _git/git.example.com/team/rules/ # any other git remote: _git/<host>[_<port>]/<path without .git>
|   `-- _local/memories-a3f1c8d2/       # a local source: _local/<basename>-<8 hex of the absolute path>
|-- state.json                          # intent: what should be true
|-- state.json.lock                     # the writer mutex, present only while a process writes
|-- config.json                         # user defaults for future commands; never read as intent
|-- last-sync                           # the stamp quiet-mode syncs debounce on
`-- log/refresh.log                     # rolling, capped: what each run changed

<project>/.agents/
|-- memories/                           # bodies linked in by a project install
`-- maxims.lock                         # the project manifest, committed; replayed by `maxims install`
```

The home sits inside `.agents`, the directory `npx skills` already owns, so no new dotfolder appears and the layout is the same whether or not Claude Code is installed. Project memory directories link into it and rule lines point into it; the store is the only place a body lives, so a stale body cannot exist.

A local or git source's store path is derived from its path or URL every run, never stored. `_local` and `_git` are segments no GitHub owner can have, since owner names cannot start with an underscore, so the namespaces cannot meet. A store entry no source in state derives to is swept on the next sync.

Two files are not state. `config.json`, beside it, holds the [user defaults](cli.md#user-defaults-in-configjson), which are preferences about future commands. The project manifest, in the project's `.agents/`, is the committed record a fresh clone replays.

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
| the project's source list for a fresh clone | `.agents/maxims.lock` in the project, below; state is per machine and the manifest is per repository |

Storing "it is installed" beside "it should be installed" creates two fields that can disagree the moment a user hand-edits a settings file. With no actuality fields there is nothing to reconcile, and recovery from any crash is `maxims sync` again.

## The project manifest

`.agents/maxims.lock` is the file maxims writes to be committed. A project-scope `add`, `remove`, `link`, `unlink`, `disable`, or `enable` rewrites it from state as a projection of the sources whose destination is this project. `maxims install` in a fresh clone reads it, adds each source at project scope, then syncs.

Strategy B rule files also land in the repo, but as the harness's target, never as a record maxims reads.

| property | reason |
| --- | --- |
| keys sorted, no timestamps, no fetch facts | two teammates running the same `add` produce the same bytes, so the file's diff is the intent change and nothing else |
| holds a projection of intent only: every `intent` field `add` recorded for the source, so `from` with its ref, selection, renames, rule flag, harnesses, memory folder, full depth, copy, and paths, plus the project-scope disabled list | a sha or a fetched-at would churn on every refresh and say nothing a teammate needs, and a missing `--from` would send the replay to the wrong folder |
| written whole, temp plus rename, like state | a half-written manifest has no representation |
| absent means no project sources | `install` with no manifest exits 0 and prints "no manifest" |

The manifest never replaces state on the machine that wrote it, and `sync` never reads it. `install` is an `add` per entry plus a `disable` per disabled name, so the result is ordinary state that `sync` drives; the manifest is only how a clone learns what to add.

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
        "select": ["rubber-duck-before-every-commit"],
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
        "sha": "fc675572711b0a1c9e...",
        "memoryPath": "memories",
        "memories": {
          "rubber-duck-before-every-commit": { "content": "sha256:9f2a...", "description": "sha256:11cd..." }
        },
        "lastError": null
      },
      "addedAt": "2026-08-20T08:38:04.471Z"
    }
  }
}
```

The sha and hash values above are shortened for display; state stores full digests.

| field | why it exists |
| --- | --- |
| `version` | integer schema version, bumped on any breaking shape change |
| `writtenBy` | which maxims wrote this, so a bug report is reproducible without asking |
| `hooks` | the harnesses where the user wants a sync hook kept: a list, not records |
| `intent.from` | `github` with `repo`, `ref`, and `host` only when `GH_HOST` named an enterprise instance at `add` time, so the source is never re-expanded against `github.com` later; `git` with the remote `url` as you typed it and `ref`; or `local` with `path` and optional `live`. A pinned local directory or a live fetched source cannot be written down. `HEAD` means the default branch's head; the branch name is never stored because a repo can rename it. |
| `intent.auth` | whether refreshes of this source use your `gh` login; set by `--auth`, false by default, so an anonymous install never turns authenticated on its own |
| `intent.select` | `*` or an explicit list; applied every sync, so a refresh can never widen the selection |
| `intent.rename` | upstream name to local name; why it exists is not stored, `list` re-derives whether it still resolves a live collision |
| `intent.rule` | whether this source publishes one-liners; the field that separates `--rule` from `--add-hook` |
| `intent.destination` | `global`, `project`, or `out` with a path; `-g` with `-o` has no representation |
| `intent.copy`, `intent.memoryPath`, `intent.fullDepth`, `intent.paths` | `--copy`, `--from`, `--full-depth`, `--paths`, recorded per source |
| `intent.harnesses` | which harnesses this source writes to |
| `fetched.at`, `fetched.sha` | drive the cooldown and staleness; the sha is what was fetched, versus `ref`, which is what was asked for. A copied local source hashes its directory contents here. A live local source has no `fetched` block at all, because the tree is the record. |
| `fetched.memories` | a content hash and a description hash per memory, so a body-only edit skips the rule rewrite |
| `fetched.lastError` | why the last fetch failed (`network`, `ratelimit`, `missing`, `auth`, `invalid`), so the staleness notice can say which |
| `addedAt` | provenance; there is no `updatedAt` |

Specified, not yet in the schema: `disable` records the memories it withheld, by local name, in one list per scope, so a memory disabled at project scope stays live for `-g`. The [project manifest](#the-project-manifest) copies the project-scope list so `install` can replay it.

Each source is keyed by what identifies it, never by a memory name, which is what makes an upstream rename disappear cleanly. The block is regenerated from the store's current content, so a vanished name cannot survive in the output.

| source | key | note |
| --- | --- | --- |
| GitHub | `@owner/repo`, or `@<host>/owner/repo` on a GitHub Enterprise host | the key keeps the case you typed, but GitHub names are case-insensitive and the store folds them, so two keys whose `owner/repo` differ only by letter case are corrupt and the file is refused; a `#<ref>` suffix is compared as typed |
| any other git remote | the URL as you typed it | never rewritten |
| local directory | its absolute path | |
| any pinned source | the key above plus `#<ref>` | `@acme/rules` and `@acme/rules#v2` are two sources and may both be installed |

## Idempotency

Running the same `add` twice against an unchanged source, or `sync` any number of times, produces byte-identical files and makes zero writes after the first.

| property | guarantee |
| --- | --- |
| store | the recorded sha is compared to the remote's before any download; equal means the fetch is skipped entirely. A live local source has no sha, so sync reads its tree and lets the output comparison decide. |
| bodies | written only when the file's content differs from the recorded content hash |
| rule file | regenerated from intent plus store, then compared; identical output means no write, so mtime does not churn |
| state | `addedAt` is set once and intent changes only when the user changes it; a sync writes state only to record a refresh it performed |
| hook | keyed by harness, not by source; the registry is rewritten only when the constructed entry differs |
| ordering | rule lines sort by memory name, so the "nothing changed" fast path fires across machines |

There is one durable commit point, the state write, done as temp file plus rename. Every artifact after it is derived, so an interruption anywhere past that write is repaired by the next sync, which is what the next session start runs anyway.

## Failure paths

| failure | behavior |
| --- | --- |
| fetch fails before any write | keep the last good store, exit 2 (0 with `--quiet`) |
| fetch succeeds, some files fail the contract | install the valid ones, warn per bad file |
| fetch succeeds, every file fails the contract | treat as an empty source; the existing block survives, exit 3 |
| write fails partway through linking bodies | intent is already correct, nothing is stranded, exit 4 |
| write fails on the rule file | bodies stay, block unchanged, exit 4; temp plus rename means a partial file has no representation |
| process killed between store swap and rule write | the next sync re-derives everything from intent |
| hook fires while a manual add holds the lock | the hook exits 0 immediately without waiting |
| two manual adds at once | the second polls, then exits 5 |
| source repo deleted upstream | keep the last good copy, warn at every start, never auto-remove |
| store copy missing on a new machine | sync refetches on the spot, cooldown or not |
| a live source's directory moved or deleted | the symlink dangles and there is no copy: keep the existing block, report the error, never wipe |
| a live edit breaks a wikilink or crosses the cap | that source's block keeps its previous content; other sources are unaffected |

Never auto-removing on a fetch failure is deliberate. A rate limit and a deleted repo look alike from the client, and dropping a commit-review rule because GitHub returned 403 is the failure class maxims exists to prevent.

## Concurrency

The store is single-writer. A writer creates `state.json.lock` atomically, holding its pid, host, start time, and command line. Reads never take the lock, and every write is temp plus rename, so a session starting mid-sync sees the old rule file or the new one, never a partial one.

| situation | behavior |
| --- | --- |
| two adds, different sources | the second polls for up to 5 seconds, then exits 5 with the holder's command line |
| a hook fires during a manual add | the hook does not wait: exit 0 at once, logged as "skipped, lock held" |
| two syncs at once | one wins, the other exits 0; both would compute the same output |
| the holder crashed and left the lock | a lock older than 60 seconds is stolen, and the theft is logged with whether the holder's pid was still alive |
| NFS or a container where pid checks lie | age alone breaks the lock at 60 seconds; the worst case is a redundant rewrite |

## Migrations

State migrates forward only. A `version` below the current one runs the ordered steps, each a pure function over the JSON, then writes back atomically and continues. A `version` above the current one is a clean stop. In quiet mode it exits 0 with "state written by a newer maxims, skipping"; otherwise it asks the user to upgrade, because a rewrite would destroy fields the older binary cannot see.

| rule | reason |
| --- | --- |
| each step is named for the version it migrates away from | a step is authored against the shipped shape, with no guess at the next release number |
| steps chain in ascending order and each is idempotent | an update can be retried, so a step may run twice |
| one golden fixture per step | the shape change is proven, not described |
| steps are deleted once a hard break makes them unreachable | the migration directory is not allowed to accumulate compatibility baggage |
| downgrading past a migration is unsupported | recovery is the same as corruption: quarantine and re-add |

A corrupt state file is moved aside to `state.json.corrupt-<timestamp>` and the user is told to re-add. It is not rebuilt from the rule files, because no reading of a managed block reveals which memories the user selected or whether they asked for rule lines. Only intent-shape changes ever need a migration; everything derived is regenerated by the next sync at the current spec.
