// Refuses to run outside scripts/run_tests.ts: a bare `bun test` would inherit the developer's real
// HOME and every test that writes harness config would land in it.
import { afterAll, afterEach } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { git } from "./git_fixture.ts";

if (process.env.MAXIMS_TEST_LAUNCHER !== "1") {
  throw new Error(
    "tests run only through `bun run test` (scripts/run_tests.ts), not bare `bun test`",
  );
}

const home = process.env.HOME;
if (home === undefined || home === "") throw new Error("the test launcher must set HOME");
const realHome = realpathSync(resolve(home));
const realTmp = realpathSync(tmpdir());
if (realHome !== realTmp && !realHome.startsWith(realTmp + sep)) {
  throw new Error(`HOME must be under the OS tmpdir (${realTmp}), got ${realHome}`);
}

// A git process a test runs with its cwd inside the checkout writes into the checkout's own config
// and nothing fails: a partial fetch by URL registers a promisor remote there and the test passes.
// The common config is read back after every test, so the failure names the test that wrote it.
// Branch sections are the one concurrent writer (a sibling worktree's `git branch`, `checkout -b`
// or `push -u` writes them into the same shared file) and are left out of the comparison.
// The container tier (tests/container/entrypoint.sh) runs the suite on a copy without `.git`, so
// no checkout there means nothing to guard; any other discovery failure fails the run.
const checkoutConfig = checkoutConfigPath();
if (checkoutConfig !== undefined) {
  let snapshot = readFileSync(checkoutConfig);
  const unchanged = (): void => {
    const current = readFileSync(checkoutConfig);
    if (current.equals(snapshot)) return;
    const changed = withoutBranchSections(current) !== withoutBranchSections(snapshot);
    snapshot = current;
    if (changed) {
      throw new Error(
        `a test wrote to the checkout's git config (${checkoutConfig}); every git process a test runs belongs in a scratch repository`,
      );
    }
  };
  afterEach(unchanged);
  afterAll(unchanged);
}

function checkoutConfigPath(): string | undefined {
  try {
    return join(
      git(process.cwd(), ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      "config",
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("not a git repository")) return undefined;
    throw error;
  }
}

function withoutBranchSections(config: Buffer): string {
  return config.toString("utf8").replace(/^\[branch "[^\n]*"\]\r?\n(?:[ \t][^\n]*\r?\n)*/gm, "");
}
