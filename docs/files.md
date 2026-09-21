---
order: 52
group: Reference
---

# Files on disk

Everything maxims owns lives under one directory, and this page is that tree: what each file is for, and the keys `config.json` accepts. The [state page](state.md) owns what `state.json` records and how it migrates, and the [share page](share.md#the-project-manifest) owns the lock a project commits.

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
|-- pending/                            # a reviewed source's fetched, not yet accepted revision, laid out like store/
|   `-- acme/rules/
|-- state.json                          # intent: what should be true
|-- state.json.lock                     # the writer mutex, present only while a process writes
|-- config.json                         # user defaults for future commands; never read as intent
|-- last-sync                           # the stamp quiet-mode syncs debounce on
`-- log/refresh.log                     # rolling, capped: what each run changed

<project>/.agents/
|-- memories/                           # bodies linked in by a project install
`-- maxims.lock                         # the project lock, committed; replayed by `maxims install`
```

The home sits inside `.agents`, the directory `npx skills` already owns, so no new dotfolder appears and the layout is the same whether or not Claude Code is installed. Project memory directories link into it and rule lines point into it; the store is the only place a body lives, so a stale body cannot exist.

A local or git source's store path is derived from its path or URL every run, never stored. `_local` and `_git` are segments no GitHub owner can have, since owner names cannot start with an underscore, so the namespaces cannot meet. A store entry no source in state derives to is swept on the next sync, and so is a held revision under `pending/` whose source no longer holds it.

Two files are not state. `config.json`, beside it, holds the [user defaults](#user-defaults-in-configjson), which are preferences about future commands. The [project lock](share.md), in the project's `.agents/`, is the committed record a fresh clone replays.

## User defaults in config.json

`<MAXIMS_HOME>/config.json`, `~/.agents/maxims/config.json` by default, holds the defaults you would otherwise repeat on every command. It is a file beside state, never a part of it.

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
| `lastAgents` | no flag; the harnesses the last interactive `add` selected | the detected harnesses |

`add` writes `lastAgents`, and the next interactive prompt preselects it.

`cooldownDays` and `ruleCap` are the two keys `sync` reads, since they govern every run; the [cap and cooldown section](keep-fresh.md#the-cap-and-the-cooldown) owns the flags that write them and when a typed flag persists. `agents`, `yes`, `addHook`, and `rule` each fill in a flag you did not type on `add`, and what `add` records is ordinary intent.

`config set` refuses a key the table does not name, with exit 1, and the file is parsed the same way: a misspelled key makes the whole file invalid rather than being ignored.
