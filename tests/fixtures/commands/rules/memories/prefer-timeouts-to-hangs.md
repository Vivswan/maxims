---
name: prefer-timeouts-to-hangs
description: Use when a call leaves the process, however small - give it a timeout, since a hang is worse than a clear failure
metadata:
  node_type: memory
  type: feedback
---

**Why:** a hung call looks like progress until someone checks.

**How to apply:** pass the deadline in with the call and fail loudly when it passes.
