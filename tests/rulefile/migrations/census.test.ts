// Guards the managed block's upgrade path: a rung whose "before" file no longer lands on the
// current fixture, a current fixture the scanner no longer reads, or a corrupt fixture the scanner
// reads as text would leave a user's block beside a fresh one or silently rewrite it, and nothing
// is visible until a user's rule file is older than the binary.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MarkerRefused,
  parseBlocks,
  replaceBlock,
  stripBlock,
} from "../../../src/rulefile/block.ts";
import { BLOCK_LADDER } from "../../../src/rulefile/migrations/block-ladder.ts";
import { ExitCode } from "../../../src/util/exit-codes.ts";
import { srcPath } from "../../shared/src_path.ts";

const FIXTURES = srcPath("rulefile", "fixtures");
const SOURCE = "@example-user/rules";
const FRESH = "<!-- maxims:begin x sha=y version=1 -->\n<!-- maxims:end x -->\n";

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

function named(prefix: string): string[] {
  return readdirSync(FIXTURES).filter((name) => name.startsWith(prefix));
}

test("current.md holds one block the scanner reads whole, and a before fixture stands per rung", () => {
  const current = fixture("current.md");
  const { blocks, warnings } = parseBlocks(current);
  expect(warnings).toEqual([]);
  expect(blocks.map((block) => [block.source, current.slice(block.start, block.end)])).toEqual([
    [SOURCE, current.slice(current.indexOf("<!-- maxims:begin"))],
  ]);
  expect(named("before-")).toHaveLength(BLOCK_LADDER.steps.length);
});

// Reading, replacing and stripping all refuse the file, so no path writes it: the refusal names the
// marker line and the fix, and the bytes stay the user's until they delete the block by hand.
test.each(named("corrupt-"))("%s is refused by the scanner and both writers", (name) => {
  const text = fixture(name);
  const marker = text.split("\n").find((line) => line.startsWith("<!-- maxims:begin")) ?? "";
  const reads = [
    () => parseBlocks(text),
    () => replaceBlock(text, SOURCE, FRESH),
    () => stripBlock(text, SOURCE),
  ];
  for (const read of reads) {
    let caught: unknown;
    try {
      read();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MarkerRefused);
    if (!(caught instanceof MarkerRefused)) return;
    expect({ code: caught.code, message: caught.message, hint: caught.hint }).toEqual({
      code: ExitCode.DestinationWriteFailed,
      message: `the marker ${JSON.stringify(marker)} carries no version; this maxims writes version 1 and cannot refresh the block it opens`,
      hint: "delete the block from that line through its maxims:end line, then run sync, which writes it afresh",
    });
  }
});
