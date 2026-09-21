// What would drift silently: the names a block on disk carries are read back through the same
// line grammar the block parser uses, so a rule file an editor saved with CR or CRLF endings
// still yields its names to `doctor --expect` and to the name index (a split on LF alone would
// read such a file as a block with no rules), and a detail path carrying a Unicode line separator
// still names its memory (a dot without dotAll would refuse it).
import { expect, test } from "bun:test";
import type { MemoryName } from "../../memory/contract.ts";
import { renderBlock } from "../../rulefile/block.ts";
import { parseRuleBlocks } from "./blocks.ts";

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

const endings: [string, string][] = [
  ["LF", "\n"],
  ["CRLF", "\r\n"],
  ["CR", "\r"],
];

test.each(endings)("a block saved with %s endings yields every rule name", (_label, ending) => {
  const text = `# Mine${ending}${ending}${block.replaceAll("\n", ending)}`;
  expect(parseRuleBlocks(text)).toEqual([{ source: "@acme/rules", names: NAMES }]);
});

test("a detail path carrying a Unicode line separator still yields its name", () => {
  const text = blockUnder("/home/user/notes\u2028more/.agents/maxims/store/acme/rules");
  expect(parseRuleBlocks(text)).toEqual([{ source: "@acme/rules", names: NAMES }]);
});
