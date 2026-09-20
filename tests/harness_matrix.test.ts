// Fails if docs/harnesses.md falls behind the harness registry: a definition added, renamed, or
// re-pathed in src/harnesses would otherwise ship beside a page still describing the old one. Also
// fails if the renderer stops showing a scope with no target, a definition with no hook, or a
// missing budget as the "none" and "-" cells the page's legend describes, renders a hook path for a
// scope the harness does not install into, or collapses a per-scope budget or MCP file to one cell.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MATRIX_PAGE, renderPage, renderRow } from "../scripts/render_harness_matrix.ts";
import type { HarnessDefinition } from "../src/harnesses/contract.ts";

test("the committed page carries the matrix rendered from the registry", () => {
  const page = readFileSync(resolve(import.meta.dir, "..", MATRIX_PAGE), "utf8");
  expect(renderPage(page)).toBe(page);
});

// Hand-written definitions covering shapes and combinations the registry does not: no hook, a null
// global target, no budget, a registry hook beside a null global target, a per-scope budget with
// a one-scope MCP file, a shared block with a precedence list.
const base: HarnessDefinition = {
  id: "cursor",
  displayName: "Example",
  tier: 2,
  targets: { project: { kind: "shared-block", file: "RULES.md" }, global: null },
  bodiesDir: () => null,
  hook: { kind: "none" },
  markers: "counted",
  expands: [],
  detect: () => false,
  verifiedAgainst: { url: "https://example.com", date: "2026-09-20" },
};

const cases: [name: string, def: HarnessDefinition, row: string][] = [
  [
    "no hook, no global target, no budget render as none and -",
    base,
    "| `cursor` | Example | 2 | `RULES.md` block | none | B | none | - | - | counted | - |",
  ],
  [
    "a hook path renders only for a scope the harness installs into",
    {
      ...base,
      hook: {
        kind: "registry",
        path: (scope, ctx) => (scope === "global" ? `${ctx.home}/hooks.json` : ".hooks.json"),
        format: "json",
        eventPath: ["hooks", "sessionStart"],
        grouped: false,
        handler: () => ({}),
        commandKey: "command",
        stdout: "plain",
        async: false,
      },
    },
    "| `cursor` | Example | 2 | `RULES.md` block | none | B | `sessionStart` entry in `.hooks.json` | `plain` | - | counted | - |",
  ],
  [
    "a precedence list, a per-scope budget, and a one-scope MCP file each render in full",
    {
      ...base,
      targets: {
        project: { kind: "shared-block", file: "RULES.md", precedence: ["A.md", "RULES.md"] },
        global: null,
      },
      byteBudget: { project: 12_000, global: 6000 },
      mcp: {
        path: (scope, ctx) => (scope === "global" ? `${ctx.home}/mcp.json` : null),
        serversPath: [],
      },
    },
    "| `cursor` | Example | 2 | `RULES.md` block, written into the first existing of `A.md`, `RULES.md` | none | B | none | - | `~/mcp.json` | counted | project 12,000 bytes, global 6,000 bytes |",
  ],
];

test.each(cases)("%s", (_name, def, row) => {
  expect(renderRow(def)).toBe(row);
});
