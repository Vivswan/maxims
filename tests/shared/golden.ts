import { expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const GOLDEN = resolve(import.meta.dir, "..", "fixtures", "golden");

/** Returns `text` with the run-specific values a printed frame carries masked: the home (its paths in the forward-slash spelling the goldens hold) and the token estimate that follows the path lengths. */
export function redactRun(text: string, home: string): string {
  return text
    .replaceAll(home, "<HOME>")
    .replace(/<HOME>\S*/g, (path) => path.replaceAll("\\", "/"))
    .replace(/~\d+ tokens/g, "~N tokens");
}

/** Fails unless `actual` is tests/fixtures/golden/`name`.txt byte for byte. MAXIMS_UPDATE_GOLDEN=1 rewrites the file from `actual` first, and the diff is then reviewed like any other change to what the user sees. */
export function expectGolden(name: string, actual: string): void {
  const path = join(GOLDEN, `${name}.txt`);
  if (process.env.MAXIMS_UPDATE_GOLDEN === "1") writeFileSync(path, actual);

  expect(actual).toBe(readFileSync(path, "utf8"));
}
