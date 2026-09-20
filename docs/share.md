---
order: 41
group: Guides
---

# Share rules with your team

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
| `add -p` without `--share` | records the source, private; a re-add of a shared source records it private again | untouched by a private source; a re-added source leaves it |
| `add -p --share` | records the source | gains the source |
| `share <source>` | marks the source shared | gains the source |
| `unshare <source>` | clears the mark; the source stays installed | loses the source |
| `remove <source>` | drops the source | loses the source |
| a project-scope `link`, `unlink`, `disable`, or `enable` on a shared source | changes the intent | rewritten from state, so the two never disagree |

## The project manifest

The lock is a projection of state, written for a reader on another machine.

Strategy B rule files also land in the repo, but as the harness's target, never as a record maxims reads.

- **Keys sorted, no timestamps, no fetch facts.** Two teammates running the same `add` produce the same bytes, so the file's diff is the intent change and nothing else.
- **A projection of intent only.** Every `intent` field `add` recorded for each shared source, plus the project's disabled names that belong to a shared source. A sha or a fetched-at would churn on every refresh and say nothing a teammate needs, and a missing `--from` would send the replay to the wrong folder.
- **The fields:** `from` with its ref, the selection, renames, the rule flag, harnesses, the memory folder, full depth, copy, and paths. The memory folder, full depth, and copy appear only when they differ from what `add` records without a flag.
- **Written whole, temp plus rename, like state.** A half-written lock has no representation.
- **Absent means no shared sources.** `install` with no lock exits 0 and prints "no manifest".

The lock never replaces state on the machine that wrote it. A machine edits only the entries it owns. A teammate's entries, and the disabled names of their sources, stay through everything a clone does before it runs `install`.

## Replaying it on a fresh clone: install

```bash
npx -y @vivswan/maxims install
```

`install` in a fresh clone reads the lock, adds each source at project scope, then syncs, so the first session start already holds the team's rules. It is an `add` per entry plus a `disable` per disabled name; the result is ordinary state that `sync` drives, and the lock is only how a clone learns what to add.
