---
order: 45
group: Guides
---

# When something breaks

What a session start, a sync, or an install can report, what each report means, and what to do. This page owns the symptoms; the pages it links own the mechanisms. Every exit code is in the [exit code table](cli.md#exit-codes).

## Exit 8: the source is over the rule cap

**What you see:** `add`, `sync`, or `update` refuses one source with exit 8, and the hint names `--memory` and `--cap`. Nothing is written for that source, and every other source is unaffected.

**What it means:** the source's rule-flagged set has more memories than `ruleCap` allows, 25 by default. The [cap](keep-fresh.md#the-cap-and-the-cooldown) is a count and a hard gate; truncating would drop the last rule silently.

**What to do:** install fewer memories, or raise the cap once, which persists it in `config.json`:

```bash
npx -y @vivswan/maxims add @owner/repo --rule -m rubber-duck-before-every-commit,gate-exit-conditions-the-merge
npx -y @vivswan/maxims add @owner/repo --rule --cap 40
```

## Exit 8: a rule file is over the harness byte budget

**What you see:** the run names the newest source in the file and how many bytes over the budget it is, with exit 8. That source is held and every other source in the file refreshes; when the file is still over, the next newest is held too. The `byte budget` column of the [harness matrix](harnesses.md#the-matrix) shows which harnesses have one.

```text
x  @you/notes is 716 bytes over the budget for /home/user/AGENTS.md
   narrow the install with --memory or split the source, or keep @you/notes off DeepSeek Harness with maxims unlink @you/notes -a dsh
```

**What it means:** the harness loads at most that many bytes, so a larger file would lose rules silently; maxims holds a source rather than truncate. A held source keeps the rules it had on disk. The [DeepSeek Harness catch](harnesses.md#per-harness-catches) is the case that set the rule.

**What to do:** give that harness fewer rules from the held source: narrow its selection with `--memory`, or keep it off that harness with `unlink <source> -a <id>`.

## Exit 5: store locked

**What you see:** a command waits up to 5 seconds, then exits 5 with this message and hint, `<who>` being the holder's command line, pid, host, and start time, or `an unidentified process` when the lock file carries no record:

```text
store is locked by <who>
wait for it to finish, or remove <path to state.json.lock> if that process is gone
```

**What it means:** another maxims process holds `state.json.lock`: a second manual command, or a hook that took the lock first. A hook that meets a held lock exits 0 without waiting, so the hook itself never reports this; the [concurrency section](guarantees.md#concurrency) owns the rules.

**What to do:** let the other command finish and run yours again. A lock left behind by a crashed process is stolen after 60 seconds on its own, and the theft is logged.

## Exit 4: a harness config could not be written

**What you see:** exit 4 naming a file, for example a harness config such as `settings.json`, `hooks.json`, or `opencode.json` that did not parse.

**What it means:** maxims edits only the parsed tree of a config file and never rewrites one it cannot parse. Your intent is already recorded, so nothing is stranded. The [exit code table](cli.md#exit-codes) lists the other exit 4 causes.

**What to do:** fix the file by hand, a trailing comma or a comment where the format forbids one, then run `sync`.

## Exit 3: nothing resolved to install

**What you see:** one of three messages, each with exit 3 and nothing written.

| message | cause |
| --- | --- |
| the file and the character named | a memory carries a [hidden character](write-memories.md#hidden-characters-are-refused) |
| a `--memory` name the source lacks | a misspelled or renamed memory |
| "Found 0 memories", after one warning per skipped file | the wrong folder, or every file fails the [contract](write-memories.md#the-contract) |

**What it means:** the install would be incomplete, so maxims writes nothing rather than a set of rules you believe is loaded and is not.

**What to do:** for a hidden character, fix the file upstream or pass `--allow-hidden`. For a name, `add <source> --list` prints the names the source has. For zero memories, check `--from`, and run `lint` in the source repo to see the reason per file; the [lint section](write-memories.md#lint-a-folder-before-publishing) owns it.

## state.json was quarantined

**What you see:** `sync` prints this line, `<path>` being the quarantined file beside `state.json`, named `state.json.corrupt-<timestamp>`:

```text
maxims: state.json was corrupt and moved to <path>; re-add your sources
```

**What it means:** the file did not parse against the schema, after a hand edit or a downgrade of maxims past a migration. A state file is never partly obeyed. A dry run or a read-only verb never quarantines; the [migrations section](state.md#migrations) owns the rule.

**What to do:** open the quarantined file, undo the edit, move it back to `state.json`, then `sync`. If a downgrade caused it, upgrade maxims first and then move the file back. Otherwise re-add your sources.

## A project folder moved or was renamed

**What you see:** inside the moved folder a sync installs nothing for the project, and `list` names a project root that no longer exists.

**What it means:** a project-scope source records its project root in `state.json`, as `destination: {scope: "project", root}`, and nothing follows a rename. This is by design; the [state schema](state.md#the-schema) owns the field.

**What to do:** edit the `root` of each of the project's sources, and the project's key under `disabled.project`, in `state.json` by hand, the way the [moving section](move-or-uninstall.md#back-up-or-move-to-a-new-machine) edits the other absolute paths, then run `sync` inside the folder.

## `--quiet` printed nothing

**What you see:** the hook ran, but nothing from maxims appears in the agent's context, or `sync --quiet` in a terminal prints no line.

**What it means:** quiet mode prints only what a session must hear, and a second run within 60 seconds of the last exits as soon as it reads the stamp.

| after a quiet run | on stdout |
| --- | --- |
| a source that has failed to refresh for seven days, is gone, or is invalid | one `maxims: <key> ...` line per such source, the last good copy kept |
| a write failed | one `maxims: <message>` line per failure |
| a source was held for a harness's byte budget (the exit 8 section above) | its two lines: the overage and the way out |
| a reviewed source has a revision [held for review](keep-fresh.md#hold-changes-for-review) | `maxims: <key> has <n> changed lines held for review; run maxims accept <key>` |
| a file a harness reads changed | `maxims: rules refreshed (1 file updated)`, or `(<n> files updated)` |
| none of those | nothing |
| the harness's `stdout` column in the [matrix](harnesses.md#the-matrix) is `none` or `-` | nothing reaches the agent, whatever sync printed |
| the column is `json:` | the same lines inside one JSON document, in the named field |

**What to do:** run `sync` without `--quiet` in a terminal to see the full report. `log/refresh.log` in the [canonical home](files.md#the-canonical-home) records what each run changed.

## Cline reports the TaskStart hook as failed on the first task after install

**What you see:** Cline flags its `TaskStart` hook as timed out or failed once, on the first task after `add --add-hook`, and the task itself goes on.

**What it means:** Cline stops a hook that has not finished after 30 seconds. The hook runs `npx -y @vivswan/maxims sync --quiet`, and the first run on a machine with a cold `npx` cache spends most of that budget downloading the package, so it can cross the limit before sync starts.

Nothing is lost: whatever `add` wrote is already in place, the rule file included when you passed `--rule`, and the hook only keeps it fresh.

**What to do:** Nothing is required. Once the download has completed, the package is cached and later task starts skip it. To finish the download by hand, run the same command once in a terminal and let it end:

```bash
npx -y @vivswan/maxims sync --quiet
```

The [Cline catch](harnesses.md#per-harness-catches) names the hook's other prerequisites.

## A sync notice names a harness you defined yourself

**What you see:** a terminal `sync` prints this line at every run, `<key>` being the source and `<id>` the harness id from `<MAXIMS_HOME>/harnesses.json`, and skips that harness; the [adding a harness](adding-a-harness.md#your-own-harnesses-in-harnessesjson) page owns that file.

```text
maxims: <key>: skipped <id> (<reason>)
```

**What it means:** A source in state still lists that id in `intent.harnesses`, but the file no longer defines it. Intent is never dropped on its own, so the notice repeats until you change either side. A hook run under `--quiet` does not print it; `log/refresh.log` in the [canonical home](files.md#the-canonical-home) records it.

**What to do:** Restore the definition in `harnesses.json`, or take the id out of intent with `unlink <source> -a <id>` for each source the notice names; the [verb table](cli.md#verbs) owns `unlink`.
