---
name: tests-before-the-fix
description: A fix lands with the test that failed before it, never a test written after the fact
metadata:
  node_type: memory
  type: feedback
  internal: false
---

**Why:** a test that was never red proves nothing about the bug.
