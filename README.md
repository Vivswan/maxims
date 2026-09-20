# maxims

One-line rule memories, installed from GitHub repos into coding agents, guaranteed to load every session.

```text
npx skills  : repo of skills   -> agent's skill dirs   (on-demand workflows)
npx maxims  : repo of memories -> agent's rules layer  (always-on one-liners)
```

An agent can hold a rule in its memory system and still not act on it, because memory bodies load on recall and recall is probabilistic. maxims puts each rule's one-liner where loading is guaranteed (the harness's always-loaded instruction layer) and keeps the body on disk behind a pointer, installed like a package from a versioned, reviewable repo.

```bash
npx maxims add @Vivswan/skills -g --rule --add-hook
```

Status: under construction. Documentation grows under docs/ as each behavior lands with its tests.
