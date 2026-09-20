---
order: 65
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
| `verifiedAgainst` | `{ url, date, contentHash? }`: the vendor page every fact was checked against |
| `globalRoot` | `{ default, env? }`: the directory under HOME (`.codex`, `~/.config/zed`) and the variable that relocates it, with an optional `subdir` appended to the variable's value |
| `targets` | per scope, a `rules-dir`, a `shared-block`, or `null` when that scope has no always-loaded file |
| `bodiesDir` | per scope, where memory bodies land, or `null` to leave them in the store |
| `markers` | `stripped` when the harness drops HTML comments before injection, `counted` otherwise |
| `expands` | the reference syntaxes the harness expands inside its files: `at-import`, `none`, or empty when undocumented |
| `byteBudget` | the largest file the harness loads, in bytes: one number for both scopes, or `{ project?, global? }` when the two files are capped differently |
| `detect` | `{ dirs, env? }`: directories under the global root (`.` is the root itself) or variables that mean installed |
| `hook` | `{ kind: "none" }`, a `registry` entry, or a whole `file`; see below |
| `scopeFrontmatter` | for a rules directory whose always-on form needs no preamble but a `--paths` install does |
| `mcp` | `{ path, serversPath }`: the MCP config per scope and the key path of its servers map |
| `fixtures` | built-in folders only: `config` and `hookStdin` file names under `fixtures/` |

A `rules-dir` target is `{ kind: "rules-dir", dir, fileName, frontmatter? }`. The file name must contain `{{slug}}`, which becomes the source slug.

`frontmatter.always` holds the always-on fields and `frontmatter.scoped` adds `{ fields, pathsKey, pathsAs }` for a `--paths` install; a target with `always` but no `scoped` refuses `--paths`. A target with no `frontmatter` takes its `--paths` preamble from the spec's `scopeFrontmatter`.

A `shared-block` target is `{ kind: "shared-block", file, precedence? }`. `precedence` lists, in the harness's order, the files of which it reads only the first that exists; the block goes into that one, and `file` is created when none exists.

## Hooks as data

A `registry` hook (`kind: "registry"`) is one handler edited into a config file the user also owns:

| Field | Meaning |
| --- | --- |
| `path` | the registry file per scope |
| `format` | the registry file's syntax, `json` or `toml` |
| `eventPath` | the key path to the event's handler list, such as `["hooks", "SessionStart"]` |
| `grouped` | `true` when handlers sit inside `{ matcher?, hooks: [...] }` groups |
| `wrapper` | top-level keys a fresh file needs, such as `{ "version": 1 }` |
| `handlerTemplate` | the handler object, with placeholders; the value under `commandKey` starts with `{{command}}` |
| `commandKey` | the handler key whose value starts with the maxims command; the writer finds and prunes its own entries by that prefix |
| `stdout` | how the hook may speak back: `plain`, `json:additionalContext`, `json:hookSpecificOutput.additionalContext`, `json:contextModification`, `json:additional_context`, or `none` |
| `async` | whether the harness has an async handler field and it is set |
| `debounceMs` | for a per-prompt event, the window in which a second fire does nothing |
| `tierCheck` | `{ path, format, key, demotesWhen }`: a config value whose presence demotes the harness to tier 2 |

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

The built-in Devin Local spec from `src/harnesses/devin/spec.ts`, serialised as JSON without its `fixtures`. A `harnesses.json` entry has the same shape under an id that is not a built-in.

```json
{
  "id": "devin",
  "displayName": "Devin Local",
  "tier": 1,
  "verifiedAgainst": { "url": "https://docs.devin.ai/cli/extensibility/hooks/overview", "date": "2026-09-20" },
  "globalRoot": { "default": ".config/devin" },
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
    "path": { "project": ".devin/config.json", "global": "config.json" },
    "format": "json",
    "eventPath": ["hooks", "SessionStart"],
    "grouped": true,
    "handlerTemplate": { "type": "command", "command": "{{command}}", "timeout": "{{timeoutSeconds}}" },
    "commandKey": "command",
    "stdout": "json:hookSpecificOutput.additionalContext",
    "async": false
  },
  "mcp": { "path": { "project": ".devin/mcp_config.json", "global": "mcp_config.json" }, "serversPath": ["mcpServers"] }
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

1. Create `src/harnesses/<id>/spec.ts` exporting `spec` with `satisfies HarnessSpec`, and add the id to `HARNESS_IDS` in `src/harnesses/contract.ts`.
2. Add `index.ts` exporting the compiled definition as a camel-cased constant (`geminiCli` for `gemini-cli`): `export const geminiCli = toDefinition(spec)`, passing quirks only for what data cannot say: a tier probe, a config edit, a custom hook.
3. Put a hand-written `config.*` and, for a hook that reads stdin, `hook-stdin.json` under `fixtures/`, and name them in `fixtures`.
4. Write `index.test.ts` for the facts the vendor enforces silently, and add the definition to the harness registry's static import list, whose completeness test names any folder it misses.

The folder census test under `src/harnesses/` parses every `spec.ts`, compiles it, and checks its id, export and fixtures, so a spec that violates a refinement fails there before it ships. Verify every path, key and event against the vendor's current page before encoding it, and record that page in `verifiedAgainst`.
