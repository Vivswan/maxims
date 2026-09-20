---
order: 20
group: Start here
---

# Why maxims

An agent can hold a rule in its memory and still not act on it, because memory bodies load on recall and recall is probabilistic. maxims puts each rule's one-line summary in the layer the agent loads every session and leaves the body on disk behind a pointer. This page is the reasoning; the [quickstart](quickstart.md) is the commands.

## How it works in one picture

```mermaid
flowchart LR
    repo["source repo<br/>memories/*.md"] -->|add, update, or a sync past the cooldown| store["store<br/>~/.agents/maxims/store/"]
    state["state.json<br/>what should be installed"] --> sync["sync"]
    store --> sync
    sync --> cc["Claude Code<br/>~/.claude/rules/maxims-*.md"]
    sync --> cx["Codex<br/>~/.codex/AGENTS.md block"]
    sync --> more["every other harness in the matrix"]
    hook["session-start hook<br/>npx -y @vivswan/maxims sync --quiet"] -.->|every session| sync
```

`state.json` is the only record `sync` trusts. A rule file on disk is compared to what it should be, never read back as a record, so the next sync repairs a crash or a hand edit.

## The rule the agent held but did not act on

The failure that started this tool was a "review before every commit" rule that existed as a memory file while commits went out unreviewed. The memory system had the rule. The session did not.

Before, the rule lived in a memory directory the agent searched only when it judged the memory relevant:

```text
~/.claude/projects/<project>/memory/rubber-duck-before-every-commit.md
   loaded:  when the agent decides to look        (recall, probabilistic)
   result:  a session that never looked committed unreviewed
```

After, the same rule's one-liner sits in the rules layer the harness reads at launch, and the body lives in the store:

```text
~/.claude/rules/maxims-vivswan-skills.md
   - Codex rubber-duck review before EVERY commit, however trivial.
     (detail: ~/.agents/maxims/store/vivswan/skills/rubber-duck-before-every-commit.md)
   loaded:  at every session start                 (guaranteed)
   result:  every session opens already holding the rule
```

The body's content is unchanged; its home is now the store. Only the one line that must always be present changed layers.

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

The one-liner is the memory file's `description` field, and the rule file is generated from it. One field feeds both layers, so there is nothing to drift; the [memory-files page](memory-files.md) owns the file format.

## The npx skills analogy

```text
npx skills             : repo of skills   -> agent's skill dirs   (on-demand workflows)
npx -y @vivswan/maxims : repo of memories -> agent's rules layer  (always-on one-liners)
```

Both install a versioned GitHub repo like a package, with selection, state, and removal; the difference is the target layer.

- **Skill dirs are the probabilistic layer maxims is escaping.** Skills load when invoked or judged relevant.
- **The rules layer is always loaded.** Every harness on the [harnesses page](harnesses.md) has one, and having one is what qualifies it for a row.

Rules also come from reviewable repos instead of hand-copied files, so one machine cannot silently drift from another, and a hook re-syncs them at every session start.

## What a rule costs

| item | cost |
| --- | --- |
| one rule line in the rule file | about 25 tokens, loaded every session |
| the memory body | zero tokens until an agent opens the file |
| a source at the default [rule cap](fetching.md#the-cap-and-the-cooldown) | about 600 to 700 tokens |
