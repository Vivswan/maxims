// Fails if the state example on docs/state-and-store.md stops parsing against the state schema: a
// field renamed or a brand tightened in src/state/schema.ts would otherwise leave the page showing
// a file maxims itself would quarantine.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseState } from "../src/state/schema.ts";

const STATE_PAGE = "docs/state-and-store.md";
const SCHEMA_HEADING = "## The schema";

test("the state example under the schema heading parses as current state", () => {
  const page = readFileSync(resolve(import.meta.dir, "..", STATE_PAGE), "utf8");
  const section = page.slice(page.indexOf(SCHEMA_HEADING));
  const fence = /```json\n([\s\S]*?)\n```/.exec(section);
  if (fence === null) throw new Error(`${STATE_PAGE}: no json fence under ${SCHEMA_HEADING}`);
  const parsed = parseState(JSON.parse(fence[1] ?? ""));
  expect(parsed).toMatchObject({ ok: "parsed" });
});
