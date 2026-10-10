---
name: gate-exit-conditions-the-merge
description: Never chain a merge in the same command as reading a gate log - condition the merge on the gate's exit code
metadata:
  node_type: memory
  type: feedback
---

**Why:** a merge that runs regardless of the gate makes the gate decorative.
