import { gzipSync } from "node:zlib";
import { Header } from "tar";

export type FixtureEntry = {
  path: string;
  type?: "File" | "Directory" | "SymbolicLink" | "Link";
  content?: string;
  linkpath?: string;
  typeFlag?: string;
};

// Archives are assembled header by header so an entry can carry a path no filesystem walk would
// ever produce; every path here is short enough to fit a ustar header without a pax extension.
export type TarballDamage = "corruptTail" | "truncatedBody";

export function buildTarball(entries: FixtureEntry[], damage?: TarballDamage): Uint8Array {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? "File";
    const body = Buffer.from(type === "File" ? (entry.content ?? "") : "");
    const header = new Header({
      path: entry.path,
      type,
      size: body.length,
      mode: type === "Directory" ? 0o755 : 0o644,
      mtime: new Date(0),
      uid: 0,
      gid: 0,
      linkpath: entry.linkpath,
    });
    const block = Buffer.alloc(512);
    header.encode(block, 0);
    if (entry.typeFlag !== undefined) patchTypeFlag(block, entry.typeFlag);
    blocks.push(block);
    if (body.length > 0) {
      const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
      body.copy(padded);
      blocks.push(padded);
    }
  }
  if (damage === "corruptTail") blocks.push(Buffer.alloc(512, 0xff));
  else if (damage === undefined) blocks.push(Buffer.alloc(1024));
  const archive = Buffer.concat(blocks);
  const cut = damage === "truncatedBody" ? archive.subarray(0, archive.length - 256) : archive;
  return new Uint8Array(gzipSync(cut));
}

// The type flag sits at byte 156; the checksum over the block (its own field read as spaces) is
// recomputed so the header stays valid and only the type is foreign.
function patchTypeFlag(block: Buffer, flag: string): void {
  block.write(flag, 156, 1, "ascii");
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
}

export const FIXTURE_TOP = "example-user-rules-0123abc";

export const FIXTURE_MEMORIES: Record<string, string> = {
  "commit-review":
    "---\nname: commit-review\ndescription: Review the staged diff before every commit.\n---\n\nRead the diff once more before committing it.\n",
  "tests-first":
    "---\nname: tests-first\ndescription: Write the failing test before the fix.\n---\n\nA fix without a red test first is a guess.\n",
};

export function cleanTarball(): Uint8Array {
  return buildTarball([
    { path: `${FIXTURE_TOP}/`, type: "Directory" },
    { path: `${FIXTURE_TOP}/README.md`, content: "# rules\n" },
    { path: `${FIXTURE_TOP}/memories/`, type: "Directory" },
    ...Object.entries(FIXTURE_MEMORIES).map(([name, content]) => ({
      path: `${FIXTURE_TOP}/memories/${name}.md`,
      content,
    })),
  ]);
}

export function zipSlipTarball(): Uint8Array {
  return buildTarball([
    { path: `${FIXTURE_TOP}/memories/../../evil.md`, content: "escaped\n" },
    { path: "../../evil.md", content: "escaped\n" },
    { path: `${FIXTURE_TOP}/memories/ok.md`, content: "fine\n" },
  ]);
}

export function absolutePathTarball(): Uint8Array {
  return buildTarball([
    { path: "/tmp/maxims-absolute-evil.md", content: "escaped\n" },
    { path: `${FIXTURE_TOP}/memories/ok.md`, content: "fine\n" },
  ]);
}

export function symlinkTarball(): Uint8Array {
  return buildTarball([
    { path: `${FIXTURE_TOP}/memories/x.md`, type: "SymbolicLink", linkpath: "/etc/passwd" },
    { path: `${FIXTURE_TOP}/memories/y.md`, type: "Link", linkpath: `${FIXTURE_TOP}/README.md` },
    { path: `${FIXTURE_TOP}/memories/ok.md`, content: "fine\n" },
  ]);
}

// One good entry, then a header that is not a header: the parser fails after the file landed.
export function corruptAfterOneFileTarball(): Uint8Array {
  return buildTarball(
    [{ path: `${FIXTURE_TOP}/memories/leftover.md`, content: "stale\n" }],
    "corruptTail",
  );
}

// The archive ends inside a large file's body, the shape of a download that lost its connection.
export function truncatedTarball(): Uint8Array {
  return buildTarball(
    [
      { path: `${FIXTURE_TOP}/`, type: "Directory" },
      { path: `${FIXTURE_TOP}/memories/`, type: "Directory" },
      { path: `${FIXTURE_TOP}/memories/big-rule.md`, content: "x".repeat(4096) },
    ],
    "truncatedBody",
  );
}

export function unsupportedTypeTarball(): Uint8Array {
  return buildTarball([
    { path: `${FIXTURE_TOP}/memories/odd.md`, content: "odd\n", typeFlag: "Z" },
    { path: `${FIXTURE_TOP}/memories/ok.md`, content: "fine\n" },
  ]);
}
