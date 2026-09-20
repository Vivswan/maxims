// Fails if the image stops declaring the marker the harness smoke gates on: the real CLI rows
// would then skip inside the container and the tier would pass having driven nothing.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./runner.ts";
import { CONTAINER_TIER_ENV, inContainerTier } from "./tier.ts";

test("the Dockerfile sets the tier marker the smoke reads", () => {
  const dockerfile = readFileSync(join(REPO_ROOT, "tests", "container", "Dockerfile"), "utf8");
  const prefix = `ENV ${CONTAINER_TIER_ENV}=`;
  const line = dockerfile.split("\n").find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length);
  expect({
    inside: value === undefined ? null : inContainerTier({ [CONTAINER_TIER_ENV]: value }),
    outside: inContainerTier({}),
  }).toEqual({ inside: true, outside: false });
});
