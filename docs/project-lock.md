---
order: 72
group: Reference
---

# The project lock

`.agents/maxims.lock` is the file a project commits so a fresh clone gets the team's rules with one command. It holds only the sources you chose to share, `sync` never reads it, and `install` replays it. The [state page](state.md) owns what the machine itself records.

## Sharing a source

```bash
npx -y @vivswan/maxims add @Vivswan/skills -p --rule --share   # install at project scope and share
npx -y @vivswan/maxims share @Vivswan/skills                    # share a source already installed at project scope
npx -y @vivswan/maxims unshare @Vivswan/skills                  # take it out of the lock, keep it installed
npx -y @vivswan/maxims remove @Vivswan/skills                   # take it out of state and out of the lock
```

| verb | state | the lock |
| --- | --- | --- |
| `add -p` without `--share` | records the source | untouched; the source stays yours |
| `add -p --share` | records the source | gains the source |
| `share <source>` | untouched | gains the source |
| `unshare <source>` | untouched | loses the source |
| `remove <source>` | drops the source | loses the source |
| a project-scope `link`, `unlink`, `disable`, or `enable` on a shared source | changes the intent | rewritten from state, so the two never disagree |

Status: `--share`, `share`, and `unshare` are specified, not yet built.

## The project manifest

The lock is a projection of state, written for a reader on another machine.

Strategy B rule files also land in the repo, but as the harness's target, never as a record maxims reads.

| property | reason |
| --- | --- |
| keys sorted, no timestamps, no fetch facts | two teammates running the same `add` produce the same bytes, so the file's diff is the intent change and nothing else |
| holds a projection of intent only: every `intent` field `add` recorded for the source, so `from` with its ref, selection, renames, rule flag, harnesses, memory folder, full depth, copy, and paths, plus the project-scope disabled list | a sha or a fetched-at would churn on every refresh and say nothing a teammate needs, and a missing `--from` would send the replay to the wrong folder |
| written whole, temp plus rename, like state | a half-written lock has no representation |
| absent means no shared sources | `install` with no lock exits 0 and prints "no manifest" |

The lock never replaces state on the machine that wrote it.

## Replaying it: install

```bash
npx -y @vivswan/maxims install
```

`install` in a fresh clone reads the lock, adds each source at project scope, then syncs, so the first session start already holds the team's rules. It is an `add` per entry plus a `disable` per disabled name; the result is ordinary state that `sync` drives, and the lock is only how a clone learns what to add.
