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
| `verifiedAgainst` | `{ date, sources }`: the vendor sources the facts were checked against; see below |
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

A `shared-block` target is `{ kind: "shared-block", file, precedence? }`. `precedence` lists, in the harness's order, the files of which it reads only the first that exists; the block goes into that one, and `file` is created when none exists. `skipsEmpty: true` says the harness passes over a blank file in that list, so the block does too; it is allowed only beside `precedence`.

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
| `tierCheck` | `{ layers, format, key, demotesWhen, unreadable }`: the config layers read for a demoting value |

The writer finds and prunes its own entries by the `commandKey` prefix.

A `tierCheck` walks `layers.project`, then `layers.global`, each list in the order it gives. A project entry of `{ "kind": "root-to-cwd", "file": "..." }` stands for that file in every directory from the one the session runs in up to the project root, nearest first:

- **An unreadable layer** is a file that does not parse (`json` is strict: no comments, no trailing commas), a non-table where the key path expects one, or a key of another type than `demotesWhen`. Under `unreadable: "refuses-to-start"` (Codex) any such layer is tier 2 with the reason; under `"skips-the-file"` (Claude Code) only the file the probed scope's hook is registered in is, and any other is skipped.
- **Otherwise the first layer that sets the key decides:** tier 2 when it holds `demotesWhen`, the declared tier when it does not.
- **A key no layer sets** leaves the declared tier.

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

The built-in Codex spec from `src/harnesses/codex/spec.ts`, serialised as JSON without its `fixtures`. Its `verifiedAgainst` is abridged to one source with an illustrative note: the spec file holds the current date and every source, and each re-verification moves them.

A `harnesses.json` entry has the same shape under an id that is not a built-in. Every built-in is declared this way; dsh and OpenCode add a quirk in code beside theirs for what the data cannot say.

```json
{
  "id": "codex",
  "displayName": "Codex",
  "tier": 1,
  "verifiedAgainst": {
    "date": "2026-10-07",
    "sources": [
      {
        "kind": "page",
        "url": "https://learn.chatgpt.com/docs/agent-configuration/agents-md.md",
        "claims": ["it checks for `AGENTS.override.md`, then `AGENTS.md`", "only the first non-empty file", "project_doc_max_bytes"],
        "why": "the AGENTS.md precedence is prose with no single source constant beyond the two loaders",
        "note": "AGENTS.override.md over AGENTS.md"
      }
    ]
  },
  "globalRoot": { "default": ".codex", "env": { "name": "CODEX_HOME" } },
  "targets": {
    "project": { "kind": "shared-block", "file": "AGENTS.md", "precedence": ["AGENTS.override.md", "AGENTS.md"] },
    "global": { "kind": "shared-block", "file": "AGENTS.md", "precedence": ["AGENTS.override.md", "AGENTS.md"], "skipsEmpty": true }
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
      "layers": { "project": [{ "kind": "root-to-cwd", "file": ".codex/config.toml" }], "global": ["config.toml"] },
      "format": "toml",
      "key": "features.hooks",
      "demotesWhen": false,
      "unreadable": "refuses-to-start"
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
2. Export the compiled definition from the same file as a camel-cased constant (`geminiCli` for `gemini-cli`): `export const geminiCli = toDefinition(spec)`.
3. Code the data cannot say goes in a `quirks.ts` beside the spec, passed as the second argument: a config edit (OpenCode) or a custom hook (the dsh bridge). A quirk needing the compiled paths takes them from the definition, as `(declared) => ({ reconcile: bridgeReconciler(declared) })`. One needing a spec value takes it as an argument: the spec imports the quirk, never the reverse.
4. Put a hand-written `config.*` and, for a hook that reads stdin, `hook-stdin.json` under `fixtures/`, and name them in `fixtures`.
5. Write `tests/harnesses/<id>/index.test.ts` for the facts the vendor enforces silently, and add the definition to the harness registry's static import list, whose completeness test names any folder it misses.

The folder census test under `tests/harnesses/` parses every `spec.ts`, compiles it, and checks its id, export and fixtures, so a spec that violates a refinement fails there before it ships. Verify every path, key and event against the vendor's current pages before encoding it.

Each source goes into `verifiedAgainst.sources` with the facts the nightly re-reads, as the most programmatic record the vendor publishes: a JSON schema first, then a file in the vendor's open-source repository, and a documentation page only when neither exists, with `why` saying what was looked for.

| kind | shape | what the nightly checks |
| --- | --- | --- |
| `schema` | `{ kind, url, paths, note? }` | each pointer in `paths` resolves; `{ pointer, equals }` must also hold that primitive value |
| `file` | `{ kind, repo, ref, path, claims, note? }` | each claim appears in the raw file at `<repo>/<ref>/<path>` on GitHub |
| `page` | `{ kind, url, claims, why, note? }` | each claim appears in the page's text, a markdown rendition served as text |

A claim is a short literal phrase that would disappear if the fact changed: a file name (`.claude/rules`), a key (`disableAllHooks`), a config path, a limit (`12,000 characters`), a frontmatter key (`alwaysApply`). Prefer identifiers over prose, since prose is reworded without the fact moving, and two to five claims per source is the usual count.

A pointer is an RFC 6901 JSON pointer, so a dotted key such as `amp.mcpServers` is one token: `/properties/amp.mcpServers`.

Matching is a fixed-string search with whitespace runs on both sides read as one space, and a claim that begins or ends in a word character (`[A-Za-z0-9_-]`) must begin or end at a word boundary, so `hooks` never holds on `webhooks` and `.claude/rules` needs no boundary before its dot.

Every source is read as the text it is, a raw repository file or a page's markdown rendition, so a fence quoting markup is just more text. A page that answers HTML instead of its markdown rendition reads `UNREACHABLE`, since nav text or embedded data would hold a claim by accident.

One source rarely states every fact: Pi's context-file order is in its resource loader, not its extensions page. A source's `note` names the fact it justifies, so a drift row says what to re-check.

The nightly `harness-drift` category fetches every source and gives each a verdict:

| verdict | meaning | the run |
| --- | --- | --- |
| `match` | every claim holds and every pointer resolves | passes |
| `DRIFT` | a claim or pointer is missing or a value differs; the row names it | fails |
| `UNREACHABLE` | answered with a status, a redirect, a timeout, a network error, HTML or non-JSON | fails |

A definition takes the worst verdict of its sources and the run the worst of its definitions, so a run that read nothing fails. To clear a `DRIFT` row, open the source, re-verify the facts it justifies, fix the definition or its claims and pointers to what the source states now, and set `verifiedAgainst.date` to today. `bun scripts/nightly.ts harness-drift --report-dir <dir>` runs the category locally:

```text
| id | kind | source | note | verdict | result |
|---|---|---|---|---|---|
| codex | page | https://learn.chatgpt.com/docs/agent-configuration/agents-md.md | AGENTS.override.md over AGENTS.md | DRIFT | missing: "only the first non-empty file" |
```
