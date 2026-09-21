---
order: 56
group: Reference
---

# Adding a harness

A harness is declared as data: one spec object that names its files, its hook and the vendor page the facts came from. This page is how to write that spec, either as a built-in folder in this repository or in your own `harnesses.json`. The [harness matrix](harnesses.md) owns what each shipped harness gets.

## The spec, field by field

Every path is relative to its scope root: the project root for a project install, the global root for `-g`. The global root is HOME unless `globalRoot` says otherwise.

| Field | What it holds |
| --- | --- |
| `id` | kebab-case id, what `--agent` accepts and the folder name of a built-in |
| `displayName` | the name shown in output |
| `tier` | `1` when a hook refreshes the rules by itself, `2` when nothing does |
| `verifiedAgainst` | `{ date, pages }`: the vendor pages the facts were checked against; see below |
| `globalRoot` | `{ default, env? }`: the directory under HOME (`.codex`, `~/.config/zed`) and its relocating variable |
| `targets` | per scope, a `rules-dir`, a `shared-block`, or `null` when that scope has no always-loaded file |
| `bodiesDir` | per scope, where memory bodies land, or `null` to leave them in the store |
| `markers` | `stripped` when the harness drops HTML comments before injection, `counted` otherwise |
| `expands` | the reference syntaxes the harness expands inside its files: `at-import`, `none`, or empty when undocumented |
| `byteBudget` | the largest file the harness loads, in bytes |
| `detect` | `{ dirs, env? }`: directories under the global root, or variables, that mean installed |
| `hook` | `{ kind: "none" }`, a `registry` entry, or a whole `file`; see below |
| `scopeFrontmatter` | for a rules directory whose always-on form needs no preamble but a `--paths` install does |
| `mcp` | `{ path, serversPath }`: the MCP config per scope and its servers map's key path |
| `fixtures` | built-in folders only: `config` and `hookStdin` file names under `fixtures/` |

`globalRoot.env` takes an optional `subdir` appended to the variable's value. `byteBudget` is one number for both scopes, or `{ project?, global? }` when the two files are capped differently. In `detect.dirs`, `.` is the global root itself.

A `rules-dir` target is `{ kind: "rules-dir", dir, fileName, frontmatter? }`. The file name must contain `{{slug}}`, which becomes the source slug.

`frontmatter.always` holds the always-on fields and `frontmatter.scoped` adds `{ fields, pathsKey, pathsAs }` for a `--paths` install; a target with `always` but no `scoped` refuses `--paths`. A target with no `frontmatter` takes its `--paths` preamble from the spec's `scopeFrontmatter`.

The paths land after the scoped `fields` unless `fields` names `pathsKey` with the value `null`, which fixes their place among the other keys. Cursor lists `globs` between `description` and `alwaysApply`, so its scoped fields are `{ "description": "...", "globs": null, "alwaysApply": false }`. Any other value under that key is refused, because the paths would overwrite it.

A `shared-block` target is `{ kind: "shared-block", file, precedence? }`. `precedence` lists, in the harness's order, the files of which it reads only the first that exists; the block goes into that one, and `file` is created when none exists.

## Hooks as data

A `registry` hook (`kind: "registry"`) is one handler edited into a config file the user also owns:

| Field | Meaning |
| --- | --- |
| `path` | the registry file per scope |
| `format` | `json`; `toml` is read for `tierCheck` and never written |
| `eventPath` | the key path to the event's handler list, such as `["hooks", "SessionStart"]` |
| `grouped` | `true` when handlers sit inside `{ matcher?, hooks: [...] }` groups |
| `wrapper` | top-level keys a fresh file needs, such as `{ "version": 1 }` |
| `handlerTemplate` | the handler object, with placeholders; the value under `commandKey` starts with `{{command}}` |
| `commandKey` | the handler key whose value starts with the maxims command |
| `stdout` | how the hook may speak back: `plain`, `json:additionalContext`, `json:hookSpecificOutput.additionalContext`, `json:contextModification`, `json:additional_context`, or `none` |
| `async` | whether the harness has an async handler field and it is set |
| `debounceMs` | for a per-prompt event, the window in which a second fire does nothing |
| `tierCheck` | `{ path, format, key, demotesWhen }`: a config value that demotes to tier 2 |

The writer finds and prunes its own entries by the `commandKey` prefix.

A `file` hook is `{ kind: "file", path, contentTemplate, executable, stdout }`: a whole file maxims owns, such as a plugin or an executable script.

Placeholders render from the hook command. A value that is exactly one placeholder keeps that placeholder's JSON type, so `"{{async}}"` becomes the boolean `async` flag and `"{{timeoutMs}}"` becomes `20000`; anywhere else the text is spliced in.

| Placeholder | Renders as |
| --- | --- |
| `{{command}}` | `npx -y @vivswan/maxims sync --quiet` |
| `{{argv}}` | `["npx","-y","@vivswan/maxims","sync","--quiet"]` |
| `{{async}}` | the hook's `async` flag, `true` or `false` |
| `{{timeoutSeconds}}` | `20` |
| `{{timeoutMs}}` | `20000` |

## A full example

The built-in Codex spec from `src/harnesses/codex/spec.ts`, serialised as JSON without its `fixtures`. A `harnesses.json` entry has the same shape under an id that is not a built-in. Every built-in is declared this way; Codex adds one quirk in code beside it, the tier probe that reads the project `config.toml` over the user one, because a `tierCheck` reads one file per scope.

```json
{
  "id": "codex",
  "displayName": "Codex",
  "tier": 1,
  "verifiedAgainst": {
    "date": "2026-09-20",
    "pages": [{ "url": "https://learn.chatgpt.com/docs/hooks", "note": "hooks.json and SessionStart" }]
  },
  "globalRoot": { "default": ".codex", "env": { "name": "CODEX_HOME" } },
  "targets": {
    "project": { "kind": "shared-block", "file": "AGENTS.md" },
    "global": { "kind": "shared-block", "file": "AGENTS.md" }
  },
  "bodiesDir": { "project": ".agents/memories", "global": null },
  "markers": "counted",
  "expands": [],
  "detect": { "dirs": ["."] },
  "hook": {
    "kind": "registry",
    "path": { "project": ".codex/hooks.json", "global": "hooks.json" },
    "format": "json",
    "eventPath": ["hooks", "SessionStart"],
    "grouped": true,
    "handlerTemplate": {
      "type": "command",
      "command": "{{command}}",
      "timeout": "{{timeoutSeconds}}",
      "async": "{{async}}",
      "statusMessage": "Syncing maxims"
    },
    "commandKey": "command",
    "stdout": "plain",
    "async": true,
    "tierCheck": {
      "path": { "project": ".codex/config.toml", "global": "config.toml" },
      "format": "toml",
      "key": "features.hooks",
      "demotesWhen": false
    }
  }
}
```

## Your own harnesses in harnesses.json

The file is `$MAXIMS_HOME/harnesses.json`, so `~/.agents/maxims/harnesses.json` by default. It holds one object with a `harnesses` array of specs like the one above, minus `fixtures`.

```json
{ "harnesses": [ { "id": "acme", "displayName": "Acme Agent", "tier": 2, "...": "..." } ] }
```

Every spec is parsed strictly. An unknown key, a path that is absolute or climbs out with `..`, a template with an unknown placeholder, an id that is a built-in, or an id declared twice stops the load with exit 4 and a message naming the file, the entry and the field:

```text
/home/user/.agents/maxims/harnesses.json: harnesses[0] (id "acme"): targets.project.file: expected a path relative to the scope root
```

A harness loaded from the file carries `userDefined: true`, the mark for labelling it in output so a path you declared is never mistaken for one maxims verified. State keeps a user-defined id you installed even after the file stops defining it: `sync` prints a notice and skips that harness rather than dropping your intent.

## Adding a built-in folder

1. Create `src/harnesses/<id>/spec.ts` exporting `spec` with `satisfies HarnessSpec`, and add the id to `HARNESS_IDS` in `src/contracts/harness-id.ts`.
2. Add `index.ts` exporting the compiled definition as a camel-cased constant (`geminiCli` for `gemini-cli`): `export const geminiCli = toDefinition(spec)`. Code the data cannot say goes in a `quirks.ts` beside the spec, passed as the second argument: a tier probe (Codex), a config edit (OpenCode), or a custom hook (the dsh bridge). A quirk needing the compiled paths takes them from the definition, as `(declared) => ({ reconcile: bridgeReconciler(declared) })`.
3. Put a hand-written `config.*` and, for a hook that reads stdin, `hook-stdin.json` under `fixtures/`, and name them in `fixtures`.
4. Write `tests/harnesses/<id>/index.test.ts` for the facts the vendor enforces silently, and add the definition to the harness registry's static import list, whose completeness test names any folder it misses.

The folder census test under `tests/harnesses/` parses every `spec.ts`, compiles it, and checks its id, export and fixtures, so a spec that violates a refinement fails there before it ships. Verify every path, key and event against the vendor's current pages before encoding it.

Each page goes into `verifiedAgainst.pages` as `{ url, contentHash?, note? }`. One page rarely states every fact: Pi's context-file order is in its README, not its extensions page. A page's `note` names the fact it justifies, so a drift row says what to re-check.

A page's `contentHash` is the `sha256:<hex>` of its text as the nightly drift check reads it, in `scripts/nightly/harness_drift.ts`; one normalization stands behind every stored hash. The nightly re-hashes every page and reads the definition as drift when any one of them moved.

| the page's media type | what is hashed |
| --- | --- |
| HTML | the text of the first of `main`, `article`, `[role=main]`, else the whole document |
| HTML, inside a `footer` element | build stamps such as `Last updated: Sep 21, 2026` are dropped first |
| anything else, such as a raw markdown file | the whole body |

Both branches collapse each whitespace run to one space and trim the result; the HTML branch also drops the doctype and the `script`, `style`, and `noscript` bodies.

To take a hash, record the page without one and run `bun scripts/nightly.ts harness-drift --report-dir <dir>`. The page's row reads unverifiable and its `fetched` cell is the hash to paste in:

```text
| id | url | note | verdict | stored | fetched |
|---|---|---|---|---|---|
| codex | https://learn.chatgpt.com/docs/hooks | hooks.json and SessionStart | unverifiable | (none) | sha256:66f0...8afd |
```
