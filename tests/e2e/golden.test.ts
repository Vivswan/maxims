// Fails if the frame a user sees from the bundle drifts: the console goldens are captured
// through an in-process fake engine, so a real install's stdout through node, with the engine's
// notices folded into the frame, is pinned only here.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExitCode } from "../../src/util/exit-codes.ts";
import { withTempDir } from "../shared/temp_dir.ts";
import { type Bundle, buildBundle, makeHome } from "./binary.ts";
import { installDotfiles, redact } from "./fixtures.ts";

const GOLDEN = resolve(import.meta.dir, "..", "fixtures", "golden", "e2e-add-plain.txt");

let bundleDir = "";
let bundle: Bundle;

beforeAll(() => {
  const home = process.env.HOME;
  if (home === undefined) throw new Error("the test launcher must set HOME");
  bundleDir = mkdtempSync(join(home, "maxims-e2e-bundle-"));
  bundle = buildBundle(bundleDir);
});

afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true });
});

// MAXIMS_UPDATE_GOLDEN=1 rewrites the fixture from the current output; the diff is then reviewed
// like any other change to what the user sees.
test("add prints the plain frame byte for byte at width 80 with color off", async () => {
  await withTempDir(async (dir) => {
    const home = makeHome(dir);
    const installed = await installDotfiles(bundle, dir, home);
    expect({ code: installed.run.code, stderr: installed.run.stderr }).toEqual({
      code: ExitCode.Ok,
      stderr: "",
    });
    const actual = redact(installed.run.stdout, installed, home);
    if (process.env.MAXIMS_UPDATE_GOLDEN === "1") writeFileSync(GOLDEN, actual);
    expect(actual).toBe(readFileSync(GOLDEN, "utf8"));
  });
});
