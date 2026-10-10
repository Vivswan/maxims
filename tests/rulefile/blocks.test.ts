// What would drift silently: the names a block on disk carries are read back through the same
// line grammar the block parser uses, so a rule file an editor saved with CR or CRLF endings
// still yields its names to `doctor --expect` and to the name index (a split on LF alone would
// read such a file as a block with no rules), and a detail path carrying a Unicode line separator
// still names its memory (a dot without dotAll would refuse it).
import { expect, test } from "bun:test";
import type { MemoryName } from "../../src/memory/contract.ts";
import { renderBlock } from "../../src/rulefile/block.ts";
import { parseRuleBlocks } from "../../src/rulefile/blocks.ts";

const NAMES = ["always-review", "keep-tests-green"] as MemoryName[];

function blockUnder(store: string): string {
  return renderBlock({
    source: "@acme/rules",
    sha: "3f2a9c1e",
    lines: NAMES.map((name) => ({
      name,
      description: `Rule ${name}.`,
      detailPath: `${store}/memories/${name}.md`,
      shortHash: "a1b2c3d",
    })),
    markers: "stripped",
    expands: ["at-import"],
    selfRefresh: false,
  });
}

const block = blockUnder("/home/user/.agents/maxims/store/acme/rules");
const savedWith = (ending: string): string =>
  `# Mine${ending}${ending}${block.replaceAll("\n", ending)}`;

const texts: [string, string][] = [
  ["LF endings", savedWith("\n")],
  ["CRLF endings", savedWith("\r\n")],
  ["CR endings", savedWith("\r")],
  [
    "a Unicode line separator in a detail path",
    blockUnder("/home/user/notes\u2028more/.agents/maxims/store/acme/rules"),
  ],
];

test.each(texts)("a block saved with %s yields every rule name", (_label, text) => {
  expect(parseRuleBlocks(text)).toEqual([{ source: "@acme/rules", names: NAMES }]);
});
