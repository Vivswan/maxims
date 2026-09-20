---
order: 30
group: Start here
---

# How it works

The path a rule takes from a source repo to an agent's context, one stage at a time, and what each stage writes. This page is the user-level map: every row links to the page that owns the stage, and the [architecture page](architecture.md) shows the same path as code.

## Five stages

| stage | what happens | owner |
| --- | --- | --- |
| source | `add` fetches the repo's `memories/` folder | [source layout](write-memories.md#layout-in-a-source) |
| store | the fetched files land under `~/.agents/maxims/store/` | [the canonical home](files.md#the-canonical-home) |
| state | `state.json` records what should be installed | [State](state.md) |
| rule files | `sync` writes one line per memory into each harness's always-loaded file | [the rule file](harnesses.md#the-rule-file) |
| hook | a session-start hook runs `sync --quiet` | [the session hook](keep-fresh.md#the-session-hook) |

`state.json` is the only record `sync` trusts. A rule file on disk is compared to what it should be, never read back as a record, so the next sync repairs a crash or a hand edit.

## Two layers, one source

```text
 always-loaded layer: the rule file           on-demand layer: the memory body
 +-------------------------------------+      +----------------------------------------+
 | - one-liner A   (detail: .../A.md) |----->| A.md  frontmatter, Why, How to apply   |
 | - one-liner B   (detail: .../B.md) |----->| B.md                                   |
 | - one-liner C   (detail: .../C.md) |----->| C.md                                   |
 +-------------------------------------+      +----------------------------------------+
   read by the harness every session            opened by the agent when it wants detail
```

The one-liner is the memory file's `description` field, and the rule file is generated from it. One field feeds both layers, so there is nothing to drift; the [memory file format](write-memories.md#the-contract) owns the fields.
