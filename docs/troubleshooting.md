---
order: 75
group: Reference
---

# Troubleshooting

What a session start or a sync can report after an install, what each report means, and what to do. This page owns the symptoms; the pages it links own the mechanisms.

## Cline reports the TaskStart hook as failed on the first task after install

**What you see:** Cline flags its `TaskStart` hook as timed out or failed once, on the first task after `add --add-hook`, and the task itself goes on.

**What it means:** Cline stops a hook that has not finished after 30 seconds. The hook runs `npx -y @vivswan/maxims sync --quiet`, and the first run on a machine with a cold `npx` cache spends most of that budget downloading the package, so it can cross the limit before sync starts.

Nothing is lost: whatever `add` wrote is already in place, the rule file included when you passed `--rule`, and the hook only keeps it fresh.

**What to do:** Nothing is required. Once the download has completed, the package is cached and later task starts run well inside the limit. To finish the download by hand, run the same command once in a terminal and let it end:

```bash
npx -y @vivswan/maxims sync --quiet
```

The [Cline catch](harnesses.md#per-harness-catches) names the hook's other prerequisites.

## A sync notice names a harness you defined yourself

**What you see:** `sync` prints a notice naming a harness id from `<MAXIMS_HOME>/harnesses.json` and skips that harness, at every run.

**What it means:** A source in state still lists that id in `intent.harnesses`, but the file no longer defines it. Intent is never dropped on its own, so the notice repeats until you change either side. Specified: user-defined harnesses are not yet built on this branch.

**What to do:** Restore the definition in `harnesses.json`, or take the id out of intent with `unlink <source> -a <id>` for each source the notice names; the [verb table](cli.md#verbs) owns `unlink`.
