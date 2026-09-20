---
order: 54
group: Reference
---

# What sync guarantees

What happens when a fetch, a write, or a process fails: the guarantees behind `sync` as the repair step, the failure table, and the lock. The [troubleshooting page](troubleshooting.md) owns the symptoms as you see them; this page owns the mechanisms behind them, and the [move page](move-or-uninstall.md) owns carrying an install elsewhere or removing it.

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

