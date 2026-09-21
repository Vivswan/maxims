---
order: 42
group: Guides
---

# Keep rules fresh

How installed rules stay current: the session hook, the cooldown that decides when `sync` fetches, `update` for a refresh now, how a source is fetched, a hold for review, and what an agent sees when a source goes stale. The cap sits here too; it shares `config.json` with the cooldown. Where the store lives is on the [files page](files.md#the-canonical-home); what a failed fetch keeps is on the [guarantees page](guarantees.md#failure-paths).

## The session hook

The hook runs `npx -y @vivswan/maxims sync --quiet` at every session start. `add --add-hook` registers it at the scope of that install, the user scope or the project, and a later add at another scope without the flag registers nothing there. Run it yourself to apply state now:

```bash
npx -y @vivswan/maxims sync
```

In a terminal, a run that changed no file a harness reads and failed nothing ends with one line, captured from a no-op run:

```text
o  Up to date: 4 memories, 4 rule lines
```

A source held for a [byte budget](troubleshooting.md#exit-8-a-rule-file-is-over-the-harness-byte-budget) or for [review](#hold-changes-for-review), or a failed write, prints its own line instead, and the up-to-date line stays out.

A failed fetch keeps it out too. No stale line appears until the source has gone seven days without a refresh, or at once when the repository is gone or the fetched content invalid (the stale lines below).

Until then the run prints one line on stderr naming the source and the failure, records the reason in `log/refresh.log`, and exits non-zero as the [failure paths](guarantees.md#failure-paths) say. The same run under `--quiet` prints nothing.

```text
maxims: @Vivswan/skills: fetch failed (network unreachable); kept last-good
```

In quiet mode the output is only what a session must hear: a line per source that has failed to refresh for seven days, is gone, or holds invalid content, a line per write failure, a line per revision [held for review](#hold-changes-for-review), and one when a file a harness reads changed. With none of those it prints nothing; the [quiet section](troubleshooting.md#--quiet-printed-nothing) owns the list.

```text
maxims: @Vivswan/skills has not refreshed since 2026-08-26 (network unreachable); rules may be out of date
maxims: rules refreshed (1 file updated)
```

`sync` touches the network only for a source past its fetch cooldown, and a failed fetch keeps the last good copy. The [cooldown flag](#the-cap-and-the-cooldown) sets the window; the [failure paths](guarantees.md#failure-paths) own what each failure does. A source added with `--review` keeps its rules until you run `accept`; the [review section](#hold-changes-for-review) owns that.

## One hook refreshes every harness

`maxims sync` applies state for every harness on the machine, not only the one whose hook invoked it. Any one tier 1 hook therefore refreshes every tier 2 target as a side effect, and the tenth source costs no tenth hook.

Tier 2 therefore means fresh as long as some hooked harness gets used on this machine, so a tier 2 harness is stale only on a machine with zero tier 1 harnesses. The [matrix's](harnesses.md#the-matrix) tier column shows which registered harnesses have no hook system and start at tier 2.

Copilot's IDE half has no hook at all, and Codex with hooks switched off or Cline without hooks enabled also land at tier 2; the [per-harness catches](harnesses.md#per-harness-catches) name each prerequisite.

A shell-rc line, an OS scheduler, an editor folder-open task, and a git hook were each considered as a fallback for that machine and rejected. Each forks per platform or writes into shared territory for a benefit the property above already delivers. The [design decisions](design-decisions.md) page records them.

## Refresh now: update

```bash
npx -y @vivswan/maxims update
```

`update` refetches every source whatever the cooldown says, then runs the same sync. In quiet mode its output is the `sync` lines above; in a terminal it follows the `npx skills update` frame. Captured from the built CLI against a local source directory whose memory `alpha-rule` changed, cut before the trailing `~N tokens in <rule file>` line:

```text
|
o  Checking for memory updates...
o  Found 1 update(s)
o  Updated /home/user/skills (+0 -0 rule)
!  maxims: /home/user/skills refreshed (1688bf4)
!  ~ alpha-rule (05baca3 -> 94f250b)
```

The count in parentheses is memories the refresh added and removed within the selection; a changed memory is neither and earns the `~` line instead. With nothing to fetch the frame ends with one line, `o  All memories are up to date`.

## How a source is fetched

Fetching is anonymous by default. No `gh` login and no token is read unless you pass `--auth`, which records the choice as `intent.auth` so every refresh of that source uses the token `gh auth token` returns.

| situation | what runs |
| --- | --- |
| `git` on PATH | a sparse, shallow clone of the memories folder, never the repository's history |
| `git` missing, GitHub source | one whole-repository tarball download over HTTPS |
| `git` missing, any other git URL | the source is unresolvable, exit 2; a git URL has no tarball fallback |
| the fetch exceeds `MAXIMS_FETCH_TIMEOUT` | treated as a network failure; the [failure paths](guarantees.md#failure-paths) own what that keeps |
| `sync --no-fetch` | no network at all, whatever the cooldown says, for a guaranteed-offline run |

The clone covers the folder `--from` names, or the whole tree under `--full-depth`. A non-GitHub git URL is stored as you typed it and cloned as you typed it, with no host-specific resolution. The [canonical home](files.md#the-canonical-home) owns where its store entry lands.

| variable | effect |
| --- | --- |
| `MAXIMS_HOME` | moves the [canonical home](files.md#the-canonical-home), state, store, and `config.json` with it |
| `GH_HOST` | the GitHub Enterprise host `@owner/repo` resolves against, and whose URLs count as GitHub sources |
| `MAXIMS_FETCH_TIMEOUT` | seconds one fetch may take before it counts as failed |
| `MAXIMS_INSTALL_INTERNAL` | `1` installs memories marked [`metadata.internal`](write-memories.md#the-contract) |

A `github.com` URL stays `github.com` whatever `GH_HOST` says, so one pasted command installs the same source on every machine. Unset, or set to `github.com`, the variable means `github.com` and records no host.

## The cap and the cooldown

Two numbers apply to every source and live in `config.json`, not on a hook command line, so a hook has nothing to drift from. Both flags are maxims-only; `skills` has no analog.

| flag | writes | default | what it governs |
| --- | --- | --- | --- |
| `--cooldown <days>` | `cooldownDays` in `config.json` | 7 | days after a good fetch before `sync` refetches; 0 means every sync; `update` ignores it |
| `--cap <n>` | `ruleCap` in `config.json` | 25 | the most rule lines one source may publish |

The cooldown counts from the last fetch that succeeded. A fetch that failed is retried after an hour, or after any Retry-After the server sent, whatever the cooldown, so a source that is down is not asked at every session start.

The cap is a count, and it is a hard gate: over it, the whole source is refused with exit 8, never truncated. The token estimate printed beside every rule file write is a report and never blocks. The two ways out of a cap refusal are named in its hint: narrow with `--memory` or raise `--cap`.

A flag on the command line wins over `config.json` for that invocation and leaves the file alone. The two exceptions are `--cooldown` and `--cap` on `add`, `sync`, and `update`, which persist as well as apply, because a cap or cooldown typed once is meant for every later sync. On `lint`, `--cap` is a threshold for that run and persists nothing.

The [defaults section](files.md#user-defaults-in-configjson) owns the other keys of the file.

## Hold changes for review

A source added with `--review`, or marked later with `maxims review <source>`, keeps its installed rules when upstream changes. The refresh is fetched and parked; nothing a harness reads moves until you accept it. A source pinned to a commit never changes, so this is for people who want fresh and reviewed.

```text
maxims: @acme/rules has 2 changed lines held for review; run maxims accept @acme/rules
```

| step | what happens |
| --- | --- |
| `sync` or `update` sees upstream move | the revision lands under `pending/`; the installed copy stays |
| what changed | one line per memory in `log/refresh.log`; `list` and `doctor` count them |
| every later run | the line above repeats until you act, from a hook too |
| `maxims accept <source>` | applies the held revision, then syncs; `--all` takes every held source |
| upstream moves again | the newer revision replaces the held one |
| upstream returns to the installed revision | the hold is withdrawn |
| `maxims unreview <source>` | lifts the mark and applies whatever is held |

The held files sit under `pending/` in the [canonical home](files.md#the-canonical-home), laid out like the store. Each logged line is `+ name`, `- name` or `~ name (old -> new)`, the same diff `update` prints for an applied refresh.

The first fetch of a source is never held: `add` installs what it fetched, and the mark applies from the next refresh on. A live directory is read in place and cannot be reviewed. The mark is this machine's choice and is not written into the [project lock](share.md#the-project-manifest).

## The staleness notice and the self-refresh line

A source is stale once its last successful fetch is more than 7 days old, or immediately when the repo returns 404. The notice names the reason (network, rate limit, missing) rather than just "stale".

| where the harness has | the notice goes to |
| --- | --- |
| a hook with a stdout channel, anything but `none` or `-` in the [matrix](harnesses.md#the-matrix) | the hook's stdout, which the harness adds to the agent's context on exit 0 |
| a hook without one, `none` or `-` in the matrix | nowhere through the hook: the definition declares no channel the harness reads sync's output from |
| no hook (tier 2) | one managed line at the top of the maxims block in the rule file |

The stdout notice rides on exit 0, so there is no non-zero exit and no hook error banner. The rule-file line is removed on the next successful refresh.

Beneath that line, and only there, maxims writes the self-refresh line: if the staleness notice is present, run `npx -y @vivswan/maxims sync --quiet` before continuing. It is a rule asking an agent to act, so it is best-effort even from the always-loaded layer, and some harnesses gate shell commands behind approval.

On tier 1 harnesses the self-refresh line is not written, because the hook already guarantees freshness and the line would be wasted context.

Neither the notice line nor the self-refresh line counts against the [rule cap](#the-cap-and-the-cooldown); the cap governs how many of a source's memories reach the file, not what maxims says about its own state.
