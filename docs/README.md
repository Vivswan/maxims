---
order: 10
group: Start here
---

# maxims

maxims installs one-line rule memories from GitHub repos or local folders into the always-loaded instruction layer of every coding agent on a machine, and a small hook re-syncs them each time a session opens. These pages state the specified behavior the code is built and tested against; each fact lives on one page.

```bash
npx -y @vivswan/maxims add @Vivswan/skills -g --rule --add-hook
```

| I want to... | Read |
| --- | --- |
| understand the problem, the two-layer answer, and what came before | [Why maxims](why.md) |
| install a source and see what lands where | [Quickstart](quickstart.md) |
| see how the code is arranged, file by file, and who writes what | [Architecture](architecture.md) |
| write a memory file maxims accepts | [Memory files](memory-files.md) |
| look up a verb, a flag, or an exit code | [CLI reference](cli.md) |
| know what each `add` flag does, and what happens without a terminal | [Installing a source](installing.md) |
| know how a source is fetched, how often, and what `config.json` holds | [Fetching and refreshing](fetching.md) |
| check what a harness loads, lint a source folder, scaffold a memory | [Checking an install](doctor.md) |
| compare the flags and verbs with `npx skills` | [Parity with npx skills](parity.md) |
| know which agents are supported and what each one gets | [Harnesses](harnesses.md) |
| declare a harness as data, built in or in `harnesses.json` | [Adding a harness](adding-a-harness.md) |
| know what state records, where it lives, and how it migrates | [State](state.md) |
| commit a source list a fresh clone replays | [The project lock](project-lock.md) |
| know what a failure keeps, and how to move or uninstall | [Recovery](recovery.md) |
| fix what a session start or a sync reports | [Troubleshooting](troubleshooting.md) |
| read the threat model | [Security](security.md) |
| know why a behavior is the way it is | [Design decisions](design-decisions.md) |
