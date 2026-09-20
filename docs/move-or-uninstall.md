---
order: 46
group: Guides
---

# Move, back up, or uninstall

Taking rules out again, or carrying an install to another machine: `remove` for one source or one memory, the files that carry an install for a backup or a move, and the two commands that uninstall everything. What a failed run leaves behind is on the [guarantees page](guarantees.md).

## Remove a source or a memory

```bash
npx -y @vivswan/maxims remove @Vivswan/skills                  # a whole source
npx -y @vivswan/maxims remove rubber-duck-before-every-commit  # one memory by name
```

`remove` takes the source or memory out of state and syncs; there is no separate uninstall path, because the regenerated output no longer contains those lines.

In a terminal it lists "Memories to remove:" and asks "Are you sure you want to uninstall 2 memory(s)?" before acting, then reports "Removed 2 memories". The [non-interactive rules](install.md#non-interactive-behavior) own what happens without a TTY.

| after `remove` | result |
| --- | --- |
| a rule file that was only the maxims block | deleted |
| a rule file with hand-written content beside the block | the block goes, the rest stays byte for byte |
| a live local source (installed with `--link`) | the store symlink is unlinked; the source directory is never touched |
| the hook | stays until the last source leaves state, then is unregistered from every harness |

## Back up or move to a new machine

State carries the intent, so a backup is a copy of the files in step 1, and moving an install is three steps.

1. Copy `~/.agents/maxims/state.json` to the same path on the new machine, `config.json` beside it if you want the same defaults, and `harnesses.json` if you declared your own harnesses. Without that file a source naming one in `intent.harnesses` restores nothing for it, and the [dropped-harness notice](troubleshooting.md#a-sync-notice-names-a-harness-you-defined-yourself) owns what you see instead.
2. Edit the old machine's absolute paths by hand: the key and `intent.from.path` of every local source, the `path` of every `out` destination, the `root` of every `project` destination, and each project root under `disabled.project`.
3. Run `npx -y @vivswan/maxims sync`; the [failure paths](guarantees.md#failure-paths) own the refetch of a missing store copy, and the [verb table](cli.md#verbs) owns what a sync writes.

## Uninstall everything

```bash
npx -y @vivswan/maxims remove --all      # every source out of state, then a sync
rm -rf ~/.agents/maxims                  # or $MAXIMS_HOME: the store, state, config, and log
```

`remove --all` takes every source out of state and syncs; the [remove section](#remove-a-source-or-a-memory) above owns what that sync removes and when the hook goes. What remains is the canonical home itself, with an empty state and your `config.json`, and you delete that by hand.
