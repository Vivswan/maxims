<!-- BEGIN REPO-PLATFORM MANAGED -->
<!-- END REPO-PLATFORM MANAGED -->

Guidance for coding agents in this repository. `CLAUDE.md` is a symlink to this file, so edit only here. The region between the markers above is written by Vivswan/repo-platform on every sync; everything below is this repository's own.

Code is the source of truth; this section holds only the rules a reader could not recover from the code. The documentation under docs/ owns the user-facing facts.

## Hard rules

- `state.json` holds intent only. Anything that is a cached copy of the filesystem or a harness registry is re-derived by `sync`, never stored.
- `sync` is the only writer of destinations. `add`, `update`, and `remove` change intent and then call `sync`; none has a private path to the filesystem.
- Every write goes through the `Change` plan and `applyChanges`, so `--dry-run` and `--json` are structural, not per-verb.
- No backwards compatibility. Internal shapes change freely; a state-shape change ships a migration under the state module, named for the version it migrates AWAY FROM, plus a golden fixture.
- A rule file is always a real file, never a symlink. Bodies link from the canonical home; `--copy` is the escape hatch.
- A harness folder is a declaration plus its quirks. Writing logic lives once, in the shared strategies and the single hook writer. The harness registry is a static import list guarded by a completeness test.
- `sync --quiet` never exits non-zero and never blocks on stdin: a broken hook must never break a session start.
- Every written path is asserted inside its destination root. Names are parsed into a validated type at the mutation point.
- Tests run only through `scripts/run_tests.ts`, which gives them a temp HOME. A test that reads or writes the developer's real `~/.claude`, `~/.codex`, or `~/.agents` is a defect.
- No TODO, FIXME, XXX, or HACK markers: the work happens in the change or is escalated.
- Plain ASCII punctuation in every file. Markdown prose is one line per paragraph, never hard-wrapped.
- Commit subjects are Conventional Commits with at most one scope, a lower-case description, and no trailing period.

## Toolchain

- bun 1.4.2 (`.bun-version`): `bun install --frozen-lockfile`, `bun run check` (lint, typecheck, test, build, knip).
- The published artifact is `dist/cli.js`, built by `bun build --target node` with every dependency bundled at a pinned version. No install scripts.
- Dependencies are pinned exactly and reviewed at upgrade time; the CI bundle-size line is what makes a careless upgrade visible.
