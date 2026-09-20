---
name: no-sleep-waiting-on-subagents
description: Never sleep or poll waiting on a background subagent - its completion re-invokes the session on its own
metadata:
  node_type: memory
  type: feedback
---

**Why:** polling burns the budget and delays the wake-up that arrives anyway.

See also [[rubber-duck-before-every-commit]].
