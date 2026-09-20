// Fails if docs/harnesses.md falls behind the harness registry: a definition added, renamed, or
// re-pathed in src/harnesses would otherwise ship beside a page still describing the old one. Also
// fails if the renderer stops showing a scope with no target, a definition with no hook, or a
// missing budget as the "none" and "-" cells the page's legend describes, or renders a hook path
// for a scope the harness does not install into.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MATRIX_PAGE, renderPage, renderRow } from "../scripts/render_harness_matrix.ts";
import type { HarnessDefinition } from "../src/harnesses/contract.ts";

test("the committed page carries the matrix rendered from the registry", () => {
  const page = readFileSync(resolve(import.meta.dir, "..", MATRIX_PAGE), "utf8");
  expect(renderPage(page)).toBe(page);
});

// Hand-written definitions covering the shapes the registry does not: no hook, a null global
// target, no budget, and a registry hook beside a null global target.
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
    "| `cursor` | Example | 2 | `RULES.md` block | none | B | none | - | counted | - |",
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
    "| `cursor` | Example | 2 | `RULES.md` block | none | B | `sessionStart` entry in `.hooks.json` | `plain` | counted | - |",
  ],
];

test.each(cases)("%s", (_name, def, row) => {
  expect(renderRow(def)).toBe(row);
});
