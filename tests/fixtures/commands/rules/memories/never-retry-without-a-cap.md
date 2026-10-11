---
name: never-retry-without-a-cap
description: Never retry a failed call without a cap - an unbounded retry loop hides an outage from everyone
metadata:
  node_type: memory
  type: feedback
---

**Why:** a loop that retries forever turns a short outage into a hung job.

See also [[prefer-timeouts-to-hangs]].
