---
order: 60
group: Behind the design
---

# Why maxims

An agent can hold a rule in its memory and still not act on it, because memory bodies load on recall and recall is probabilistic. maxims puts each rule's one-line summary in the layer the agent loads every session and leaves the body on disk behind a pointer. This page is the reasoning; the [quickstart](quickstart.md) is the commands, and [how it works](how-it-works.md) is the mechanism.

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

## The npx skills analogy

```text
npx skills             : repo of skills   -> agent's skill dirs   (on-demand workflows)
npx -y @vivswan/maxims : repo of memories -> agent's rules layer  (always-on one-liners)
```

Both install a versioned GitHub repo like a package, with selection, state, and removal; the difference is the target layer.

- **Skill dirs are the probabilistic layer maxims is escaping.** Skills load when invoked or judged relevant.
- **The rules layer is always loaded.** Every harness on the [harnesses page](harnesses.md) has one, and having one is what qualifies it for a row.

Rules also come from reviewable repos instead of hand-copied files, so one machine cannot silently drift from another, and a hook re-syncs them at every session start.

## Prior art

Each tool below already solved part of the problem. The table says what maxims copied from it and what it left behind; the notes under it say what each tool does and where the line falls.

| tool or practice | what maxims took | what maxims left |
| --- | --- | --- |
| `npx skills` (vercel-labs/skills) | the verbs, the flags, `@owner/repo`, [`~/.agents/`](files.md#the-canonical-home), the committed lock | the skills layer itself |
| Claude Code's `MEMORY.md` index | the [two layers](how-it-works.md#two-layers-one-source), the [memory file format](write-memories.md) | the single harness and the single folder |
| rulesync (dyoshikawa/rulesync) | the fan-out, one source in each harness's own format | the unit and the trigger |
| a shell rc line, an OS scheduler, an editor folder-open task, a git hook | nothing | all four |

- **`npx skills`** installs `SKILL.md` folders from a GitHub repo into each agent's skills directory, with `add`, `list`, `remove`, and `update`, and a committed `skills-lock.json` a fresh clone replays. The [parity page](parity.md) pins the flag names and short forms against a captured `skills --help`, and the [project lock](share.md) mirrors its lock. What skills do not have is the rule line in the always-loaded layer and the session-start hook that re-syncs it.
- **Claude Code's `MEMORY.md` index** is one index file, loaded every session, with one line per memory that points at the body file beside it. Taking its format means a source repo needs no new one. maxims writes the index for every harness in the [matrix](harnesses.md#the-matrix), from a source repo, and leaves Claude Code's own memory folder to Claude Code.
- **rulesync** compiles rule files under `.rulesync/` into the native rule format of each supported agent when you run `rulesync generate`. maxims installs published memories from a repo rather than compiling your own local files, and a hook re-syncs at session start rather than a generate step you run by hand.
- **A shell rc line, an OS scheduler, an editor folder-open task, or a git hook** refreshes a file from outside the agent, on a shell start, a clock, an editor open, or a commit. None fires on the agent's session start, so a session can still open on a stale file; the [freshness fallbacks decision](design-decisions.md#harnesses) records the rest of the reasons.

## What a rule costs

| item | cost |
| --- | --- |
| one rule line in the rule file | about 25 tokens, loaded every session |
| the memory body | zero tokens until an agent opens the file |
| a source at the default [rule cap](keep-fresh.md#the-cap-and-the-cooldown) | about 600 to 700 tokens |
