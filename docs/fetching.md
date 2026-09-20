---
order: 54
group: Reference
---

# Fetching and refreshing

How a source reaches the store and how often it is refetched: the anonymous default, `--auth`, the cooldown, the cap, and the `config.json` defaults every run reads. Where the store lives is on the [state page](state-and-store.md#the-canonical-home); what a failed fetch keeps is on the [recovery page](state-and-store.md#failure-paths).

## How a source is fetched

Fetching is anonymous by default. No `gh` login and no token is read unless you pass `--auth`, which records the choice as `intent.auth` so every refresh of that source uses the token `gh auth token` returns.

| situation | what runs |
| --- | --- |
| `git` on PATH | a sparse, shallow clone of the memories folder named by `--from`, or of the whole tree under `--full-depth`; never the repository's history |
| `git` missing, GitHub source | one whole-repository tarball download over HTTPS |
| `git` missing, any other git URL | the source is unresolvable, exit 2; a git URL has no tarball fallback |
| the fetch exceeds `MAXIMS_FETCH_TIMEOUT` | treated as a network failure; the [failure paths](state-and-store.md#failure-paths) own what that keeps |
| `sync --no-fetch` | no network at all, whatever the cooldown says, for a guaranteed-offline run |

A non-GitHub git URL is stored as you typed it and cloned as you typed it, with no host-specific resolution. The [canonical home](state-and-store.md#the-canonical-home) owns where its store entry lands.

| variable | effect |
| --- | --- |
| `MAXIMS_HOME` | moves the [canonical home](state-and-store.md#the-canonical-home), state, store, and `config.json` with it |
| `GH_HOST` | the GitHub Enterprise host `@owner/repo` resolves against, and the host whose URLs count as GitHub sources. A `github.com` URL stays `github.com` whatever the shell exports, so one pasted command installs the same source on every machine. Unset, or set to `github.com`, means `github.com` and records no host |
| `MAXIMS_FETCH_TIMEOUT` | seconds one fetch may take before it counts as failed |
| `MAXIMS_INSTALL_INTERNAL` | `1` installs memories marked [`metadata.internal`](memory-files.md#the-contract) |

## The cap and the cooldown

Two numbers apply to every source and live in `config.json`, not on a hook command line, so a hook has nothing to drift from. Both flags are maxims-only; `skills` has no analog.

| flag | writes | default | what it governs |
| --- | --- | --- | --- |
| `--cooldown <days>` | `cooldownDays` in `config.json` | 7 | how long `sync` goes without refetching a source; `update` ignores it |
| `--cap <n>` | `ruleCap` in `config.json` | 25 | the most rule lines one source may publish; over it, the whole source is refused with exit 8, never truncated |

The cap is a count, and it is a hard gate. The token estimate printed beside every rule file write is a report and never blocks. The two ways out of a cap refusal are named in its hint: narrow with `--memory` or raise `--cap`.

## User defaults in config.json

`<MAXIMS_HOME>/config.json`, `~/.agents/maxims/config.json` by default, holds the defaults you would otherwise repeat on every command. It is a file beside state, never a part of it; the [canonical home](state-and-store.md#the-canonical-home) shows where it sits.

```bash
npx -y @vivswan/maxims config set rule true
npx -y @vivswan/maxims config get rule
npx -y @vivswan/maxims config unset rule
```

| key | stands in for | default when unset |
| --- | --- | --- |
| `agents` | `-a <agents>` | the detected harnesses |
| `yes` | `-y` | prompt when interactive |
| `addHook` | `--add-hook` | off |
| `rule` | `--rule` | off |
| `cooldownDays` | `--cooldown <days>` | 7 |
| `ruleCap` | `--cap <n>` | 25 |
| `lastAgents` | nothing you type: the harnesses the last interactive `add` selected, preselected by the next prompt; `add` writes it | the detected harnesses |

`cooldownDays` and `ruleCap` are the two keys `sync` reads, since they govern every run. `agents`, `yes`, `addHook`, and `rule` each fill in a flag you did not type on `add`, and what `add` records is ordinary intent.

A flag on the command line wins over the file for that invocation and leaves the file alone. The two exceptions are `--cooldown` and `--cap` on `add`, `sync`, and `update`, which persist as well as apply, because a cap or cooldown typed once is meant for every later sync. On `lint`, `--cap` is a threshold for that run and persists nothing.

`config set` refuses a key the table does not name, with exit 1, and the file is parsed the same way: a misspelled key makes the whole file invalid rather than being ignored.

Status: the first six keys are the schema maxims parses today. `lastAgents` and the `config` verb itself are specified, not yet built.
