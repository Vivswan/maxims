// Fails if the frame a user sees from the bundle drifts: the console goldens run in process, so a
// real install's stdout through node, the bundle a user runs, is pinned only here.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ExitCode } from "../../src/util/exit-codes.ts";
import { expectGolden } from "../shared/golden.ts";
import { withTempDir } from "../shared/temp_dir.ts";
import { type Bundle, buildBundle, makeHome } from "./binary.ts";
import { installDotfiles, redact } from "./fixtures.ts";

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

test("add prints the plain frame byte for byte at width 80 with color off", async () => {
  await withTempDir(async (dir) => {
    const home = makeHome(dir);
    const installed = await installDotfiles(bundle, dir, home);
    expect({ code: installed.run.code, stderr: installed.run.stderr }).toEqual({
      code: ExitCode.Ok,
      stderr: "",
    });
    expectGolden("e2e-add-plain", redact(installed.run.stdout, installed, home));
  });
});
