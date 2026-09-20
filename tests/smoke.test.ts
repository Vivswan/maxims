// Fails if the launcher stops isolating HOME: every other test relies on that isolation to keep
// the developer's real harness configs untouched.
import { expect, test } from "bun:test";

test("tests run inside the hermetic launcher with a temp HOME", () => {
  expect(process.env.MAXIMS_TEST_LAUNCHER).toBe("1");
  expect(process.env.HOME).toContain("maxims-test-home-");
});
