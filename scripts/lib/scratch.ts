// A GitHub runner empties RUNNER_TEMP at the start of every job, and
// tests/nightly/published_smoke.test.ts relies on it being read here, not in src: the shipped CLI
// keeps os.tmpdir().
import { tmpdir } from "node:os";
import { withScratchDir as withScratchDirUnder } from "../../src/util/scratch.ts";

export function withScratchDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T> | T,
  root: string = process.env.RUNNER_TEMP ?? tmpdir(),
): Promise<T> {
  return withScratchDirUnder(prefix, fn, root);
}
