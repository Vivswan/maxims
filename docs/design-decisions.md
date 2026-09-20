---
order: 90
group: Reference
---

# Design decisions

Each decision is one line, what was decided and why it will not be re-argued. The page the decision shapes owns the details; this page owns the why.

## Shape

- **The rules file is the carrier, not hook stdout.** Stdout is conversation content that cannot be inspected between sessions; the file on disk is what a harness re-reads after a compaction. Stdout is for notices only.
- **One canonical home, `~/.agents/maxims/`, with links everywhere else.** The only arrangement in which a stale body cannot exist; `--copy` is the escape hatch. Details on the [state and store page](state.md#the-canonical-home).
- **State drives everything.** `state.json` is the instruction `sync` executes, not a receipt of what `add` did; `sync` and `update` are real verbs because state, not a command line, is the source of truth.
- **State holds intent only.** A cached copy of the filesystem or a hook registry can disagree with reality the moment a user hand-edits a file, so nothing of the kind is stored; recovery from any crash is `sync` again.
- **Hooks are one per harness, not one per source.** The hook carries no source and no filter, so the tenth source adds no latency and the selection cannot drift from what `add` recorded.
- **`--add-hook` does not imply `--rule`.** Syncing bodies into a project and publishing one-liners into the always-loaded layer are separate choices, recorded per source.
- **`sync` owns the cooldown and fetches past it; `update` forces the fetch.** The alternative, a strictly local sync, needs two hook commands per session to keep the freshness guarantee.
- **No daemon, no write-back, no skill folders, no vector store.** maxims runs at `add`, `sync`, `update`, `remove`, and session start; authoring stays in the source repo.
- **No backwards compatibility.** Internal shapes change freely; a forward-only migration named for the version it leaves, plus a golden fixture, carries every installation forward, so nothing is kept for an older version.
- **Two scopes only, project and user; `-o` is an escape hatch, not a third scope.** Every harness has a project target and most have a user target, so two scopes cover the matrix; `-o` exists for the one rule file no harness owns. The [installing page](installing.md#where-it-lands) owns the shapes.
- **User defaults live in `config.json` beside state, never in state.** A default is a preference about future commands, not intent about installed sources; keeping it out of `state.json` means the intent-only rule needs no exception. This replaces the earlier `state.config` shape. The [defaults section](fetching.md#user-defaults-in-configjson) owns the keys.
- **A project commits `.agents/maxims.lock` and `install` replays it.** State is per machine, so a fresh clone would otherwise start with no rules; the lock is what a teammate's `install` reads. Sorted keys and no timestamps keep its diff to what changed. The [project lock page](project-lock.md) owns the file.
- **`disable` withholds one memory at one scope and `enable` restores it, without touching a source's intent.** Removing the memory would lose the selection and the rename; a per-scope disabled list in state keeps both and makes the withholding visible in `list`. The [verb table](cli.md#verbs) owns the verbs.

## Identity and refusal

- **Name is identity.** A content hash as identity would make an upstream one-word edit look like a second rule; the hash is recorded and shown short for change detection only.
- **A cross-source name collision is an error with a rename offered.** First-wins-and-skip would leave a rule the user believed was loaded and was not; the rename keeps both live and makes the conflict visible in the name.
- **Exceeding the [rule cap](fetching.md#the-cap-and-the-cooldown) refuses the whole source.** Truncating would drop the last rule silently and make the result depend on sort order.
- **A dangling `[[wikilink]]` is an unmet dependency and aborts the add.** Installing a rule whose prerequisite is absent is the same incomplete install as a collision or a cap breach.
- **Codes 3, 6, 7, and 8 write nothing at all.** A partial install is a set of rules the user believes is loaded and is not.
- **`--quiet` exits 0 on every outcome.** A failing session-start hook renders an error notice in the transcript, which the user would see at every start.
- **Never auto-remove on a fetch failure.** A rate limit and a deleted repo look alike from the client; the last good copy stays and a notice is printed.
- **`--rename <upstream>=<local>` resolves a collision without a prompt.** A scripted `add` that meets exit 6 has no way forward otherwise; the flag records the same entry the prompt would. The [collision section](installing.md#name-collisions-and-renames) owns it.
- **Hidden characters in a memory refuse the install unless `--allow-hidden`.** A character the reader cannot see can carry an instruction past the plan, and the plan is the review gate. The [hidden-character rule](memory-files.md#hidden-characters-are-refused) owns what counts and the exit code.
- **`metadata.internal: true` hides a memory unless the installer opts in.** A source repo can hold rules for its own maintainers without a second repo; the marker is in the file, so it travels with it. The [contract](memory-files.md#the-contract) owns the field and the opt-in variable.

## Sources and layout

- **`memories/` is the layout convention, `--from` names any other folder, `--full-depth` scans wide.** Autodetection by frontmatter would turn any README with a `name:` field into a rule.
- **`@owner/repo` fetches, `.` or a path installs locally, exactly as `npx skills` does.** The standing principle is that where `skills` has a settled behavior for the analogous case, maxims copies it rather than inventing.
- **`--pin <sha or tag>` ships.** It sets a field the GitHub source shape already carries, so it is nearly free and needs no special removal path.
- **`--link` is opt-in for local sources and default for `.`.** A copy survives a moved dotfiles folder where a dangling symlink feeds nothing; a working-tree install exists to test unpushed edits, so it is live.
- **A live source has no fetch record.** The tree is the record, so the cooldown and `update` have nothing to act on rather than a special case to guard.
- **`--paths` scoping is opt-in, never a default.** A scoped rule loads only when matching files are touched, which breaks "every session"; it is stored per source, in the target harness's own syntax.
- **`--cooldown` and `--cap` write `config.json`, not state.** They are machine-wide defaults, so they follow the [user defaults decision](#shape) above rather than living beside intent or on a hook command line; unlike the other flags, typing one persists it.
- **Fetching is anonymous by default; `--auth` opts a source in and is recorded as `intent.auth`.** Reading a `gh` token nobody asked to use turns a public-repo install into an authenticated request, and a token read is a side effect the plan never showed. The [fetch section](fetching.md#how-a-source-is-fetched) owns the order of attempts and the environment variables.
- **Any git URL is a source, stored verbatim, cloned as typed, with no tarball fallback.** Host-specific resolution would need a resolver per forge; a clone works on all of them. The [canonical home](state.md#the-canonical-home) owns its store path.
- **The default fetch is a sparse, shallow clone of the memories folder; a whole-repo tarball only when `git` is missing.** The memories folder is a fraction of most repos, and a clone needs no per-host API. `MAXIMS_FETCH_TIMEOUT` bounds a fetch so a hung remote cannot block a session start.
- **`.agents/memories/` holds project bodies on every harness.** One convention for every harness, mirroring where `npx skills` puts project skills.

## Harnesses

- **Every harness in the [matrix](harnesses.md#the-matrix) ships in the first release.** Eight are hand-written definitions; the rest are declared from data, the shape [adding a harness](adding-a-harness.md) owns, and a user's own `harnesses.json` entries take the same shape.
- **Pi ships with a file hook, not a deferred extension package.** An extension file in Pi's extensions directory receives `session_start` and runs the sync, the plugin-file pattern OpenCode uses.
- **Codex's hooks flag is read-only detection.** Hooks are on by default there; maxims reads `hooks = false` to report tier 2 achieved and never writes the flag.
- **Cursor gets a session-start hook, not a per-prompt one.** Current Cursor exposes `sessionStart`, so the earlier per-prompt shape is gone.
- **Every quiet-mode sync is debounced by 60 seconds, on every harness.** A harness that fires more than once per session does the sync work once, and the rule needs no per-harness exception.
- **`-g` on a harness with no global target warns and skips.** Cursor's user rules are UI-stored; refusing the whole command for one harness would block the other harnesses.
- **Copilot CLI is tier 1; the IDE half is tier 2.** The CLI ships a `sessionStart` hook; the IDE has none, and an editor folder-open task to promote it was rejected as too invasive.
- **OpenCode is tier 1 through a maxims-written plugin file.** Whole-file write and whole-file delete are simpler than a registry edit because nothing else lives in the file.
- **DeepSeek Harness is tier 1 through its Claude Code hook bridge, caveats recorded.** The bridge row is mounted machine-wide and its config points at a maxims-owned file, never into `.claude`; the [dsh catch](harnesses.md#per-harness-catches) owns the caveats.
- **The MCP stub ships behind the hidden `maxims mcp-serve` command.** It is the only mechanical tier 2 answer, for harnesses that start MCP servers eagerly and have no hook; the [matrix](harnesses.md#the-matrix) shows where it is registered.
- **The self-refresh line ships beside the stub.** Zero artifact and universal by construction, since every tier 2 harness has an always-loaded layer by definition; not written where a hook exists.
- **Shell-rc lines, OS schedulers, editor tasks, and git hooks are rejected as freshness fallbacks.** None fires on the agent's session start, each forks per platform or writes into a file the team shares, and the one hook already refreshes every harness. The [prior art table](why.md#prior-art) places them beside the tools maxims did borrow from.
- **The rule file is a real file, never a symlink, on every harness.** A rule that silently never loads is the failure the tool exists to prevent. The spec reports, unverified here, that Claude Code skips a symlinked rule file pointing outside the working directory.

## Tooling

- **No telemetry.** `skills` has a `--metadata` flag; maxims has no analog, deliberately.
- **The hook command carries no version pin.** Fixes reach hooked sessions without a re-add; the price is that a bad release reaches every session start, which is why the fail-soft last rung requires a dedicated test.
- **`list` ships in the first release.** It is the read command for state, and everything it shows past intent is re-derived at call time, so it reports a hand-edited registry honestly.
- **`--json` and `--dry-run` are on every verb.** Every write goes through one plan, so both are structural rather than per-verb features.
- **`doctor` checks what a harness would load; `--expect` and `--json` make it a CI assertion.** `list` reports state; `doctor` reads the harness's own loading rules against disk, which is the only way to catch a rule file at the wrong path. The [doctor section](doctor.md#doctor) owns it.
- **`init [name]` ships.** Scaffolding one contract-valid file is cheaper than explaining the contract; the [init section](doctor.md#init) owns what it writes.
- **`link` and `unlink` edit a source's harness list without a refetch; `add -a` still replaces.** Adding a harness is a one-field intent change, and a refetch for it would spend network and a cooldown for nothing. The [verb table](cli.md#verbs) owns them.
- **Non-interactively, `--yes` is implied for `add` and `sync` only; `remove` without an explicit `-y` aborts with exit 1.** Both implied verbs are idempotent and reversible; a deletion is not. `remove --all` passes because `--all` spells `-y` out. The [non-interactive table](installing.md#non-interactive-behavior) owns the matrix.
