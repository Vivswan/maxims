// Guards the folder census no single folder can: every `src/harnesses/<id>/spec.ts` parses under
// the schema (a spec object is type-checked but its refinements, such as placeholder names, only
// run here), compiles, carries the id its folder is named for, is exported from the folder's
// index.ts, and names only fixtures that exist. A folder that drifted on any of these would ship
// a harness the registry cannot pick up or a fixture the conformance suite cannot open.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_IDS } from "../../src/contracts/harness-id.ts";
import type { HarnessDefinition } from "../../src/harnesses/contract.ts";
import { toDefinition } from "../../src/harnesses/from-spec.ts";
import { parseHarnessSpec } from "../../src/harnesses/spec.ts";
import { srcPath } from "../shared/src_path.ts";

const root = srcPath("harnesses");

// Only absence excludes a folder; a folder whose spec cannot be inspected fails the census
// rather than quietly shrinking it.
function hasSpec(folder: string): boolean {
  return statSync(join(root, folder, "spec.ts"), { throwIfNoEntry: false })?.isFile() ?? false;
}

const folders = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && hasSpec(entry.name))
  .map((entry) => entry.name)
  .sort();

function isDefinition(value: unknown): value is HarnessDefinition {
  return typeof value === "object" && value !== null && "id" in value && "targets" in value;
}

test("at least one folder declares its harness as data", () => {
  expect(folders.length).toBeGreaterThan(0);
});

test.each(folders)("%s: spec parses, compiles to its own id, and is exported", async (folder) => {
  const specModule: unknown = await import(join(root, folder, "spec.ts"));
  if (typeof specModule !== "object" || specModule === null || !("spec" in specModule)) {
    throw new Error(`${folder}/spec.ts must export \`spec\``);
  }
  const parsed = parseHarnessSpec(specModule.spec);
  if (!parsed.ok) throw new Error(`${folder}/spec.ts: ${parsed.issues.join("; ")}`);
  expect(String(parsed.spec.id)).toBe(folder);
  expect(HARNESS_IDS.some((id) => id === parsed.spec.id)).toBe(true);
  const compiled = toDefinition(parsed.spec);
  for (const name of Object.values(parsed.spec.fixtures ?? {})) {
    expect(existsSync(join(root, folder, "fixtures", name))).toBe(true);
  }
  const indexModule: unknown = await import(join(root, folder, "index.ts"));
  if (typeof indexModule !== "object" || indexModule === null) throw new Error("no index.ts");
  const exported = Object.values(indexModule).filter(isDefinition);
  expect(exported.map((def) => String(def.id))).toEqual([folder]);
  expect(exported[0]?.displayName).toBe(compiled.displayName);
});
