// A definition folder nobody imported ships no harness and a duplicated id makes `--agent`
// ambiguous; the bundler cannot glob, so this test is what notices either.
import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { HARNESSES } from "./registry.ts";

test("every src/harnesses/*/index.ts is registered under its folder name exactly once", () => {
  const folders = [...new Bun.Glob("*/index.ts").scanSync({ cwd: import.meta.dir })]
    .map((entry) => dirname(entry))
    .sort();
  const ids: string[] = HARNESSES.map((def) => def.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual(folders);
});
