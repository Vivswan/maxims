# maxims

One-line rule memories, installed from GitHub repos or local folders into the always-loaded instruction layer of coding agents, and kept fresh by one session-start hook per agent. An agent can hold a rule in its memory and still not act on it, because memory bodies load on recall; maxims puts each rule's one-liner where loading is guaranteed and leaves the body on disk behind a pointer.

```text
 always-loaded layer: the rule file           on-demand layer: the memory body
 | - one-liner A   (detail: .../A.md) |----->| A.md  frontmatter, Why, How to apply   |
   read by the harness every session            opened by the agent when it wants detail
```

```bash
npx maxims add @Vivswan/skills -g --rule --add-hook
```

- [Why maxims](docs/why.md): the problem, the two layers, what a rule costs.
- [Quickstart](docs/quickstart.md): the install command and what it writes.
- [CLI reference](docs/cli.md): every verb, flag, and exit code.
- [Harnesses](docs/harnesses.md): which agents are supported and what each one gets.
- [All documentation](docs/README.md).

Status: the code is being built against these pages, so every page states specified behavior rather than observed behavior.
