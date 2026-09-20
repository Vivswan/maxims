---
order: 10
group: Start here
---

# maxims

maxims installs one-line rule memories from GitHub repos or local folders into the always-loaded instruction layer of every coding agent on a machine, and keeps them fresh with one session-start hook per agent. These pages state the specified behavior the code is built and tested against; each fact lives on one page.

```bash
npx -y @vivswan/maxims add @Vivswan/skills -g --rule --add-hook
```

| I want to... | Read |
| --- | --- |
| understand the problem and the two-layer answer | [Why maxims](why.md) |
| install a source and see what lands where | [Quickstart](quickstart.md) |
| write a memory file maxims accepts | [Memory files](memory-files.md) |
| look up a verb, a flag, or an exit code | [CLI reference](cli.md) |
| know which agents are supported and what each one gets | [Harnesses](harnesses.md) |
| declare a harness as data, built in or in `harnesses.json` | [Adding a harness](adding-a-harness.md) |
| know what state records and how a sync recovers | [State and store](state-and-store.md) |
| fix what a session start or a sync reports | [Troubleshooting](troubleshooting.md) |
| read the threat model | [Security](security.md) |
| know why a behavior is the way it is | [Design decisions](design-decisions.md) |
