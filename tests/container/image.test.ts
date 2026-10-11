// Fails if the image's node major falls below the package's engines floor: the FROM tag and the
// engines range are two files nothing else keeps in step, so the nightly tier would otherwise
// prove the suite on a node the package refuses.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { satisfies } from "semver";
import { REPO_ROOT } from "./runner.ts";

test("the image's node satisfies the package's engines floor", () => {
  const dockerfile = readFileSync(join(REPO_ROOT, "tests", "container", "Dockerfile"), "utf8");
  const image = dockerfile.match(/^FROM node:(\d+\.\d+\.\d+)-/m)?.[1];
  const { engines } = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    engines: { node: string };
  };
  const verdict =
    image === undefined
      ? "no exact FROM node:<major.minor.patch> tag"
      : satisfies(image, engines.node)
        ? "satisfies"
        : "below the floor";
  expect({ image, floor: engines.node, verdict }).toEqual({
    image,
    floor: engines.node,
    verdict: "satisfies",
  });
});
