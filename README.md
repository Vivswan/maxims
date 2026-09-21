# maxims

Rules your coding agent reads at every session start, installed from a GitHub repo and kept current by a small hook that runs when a session opens.

An agent can hold a rule in its memory and still not act on it, because memory bodies load only when the agent goes looking. maxims puts each rule's one-liner where loading is guaranteed and leaves the body on disk behind a pointer.

```bash
npx -y @vivswan/maxims add @Vivswan/skills -g --rule --add-hook
```

What maxims writes for Claude Code, one line per memory, with the detail path, the body's short hash, and the two comment lines Claude Code strips before injection. The revision and the hashes are illustrative:

```markdown
<!-- maxims:begin @Vivswan/skills sha=77769dc1e2b3a4c5d6e7f8091a2b3c4d5e6f7089 -->
<!-- managed by maxims: @Vivswan/skills - edits will be overwritten -->
<!-- update: npx -y @vivswan/maxims add @Vivswan/skills | remove: npx -y @vivswan/maxims remove @Vivswan/skills -->
- Codex rubber-duck review before EVERY commit, however trivial; coverage never transfers between reviewers. (detail: /home/user/.agents/maxims/store/vivswan/skills/rubber-duck-before-every-commit.md, a1b2c3d)
<!-- maxims:end @Vivswan/skills -->
```

- [Quickstart](docs/quickstart.md): the install command and what it writes.
- [How it works](docs/how-it-works.md): the five stages and the two layers.
- [Why maxims](docs/why.md): the problem, the prior art, what a rule costs.
- [All documentation](docs/README.md): every verb, flag, harness, and design decision.
