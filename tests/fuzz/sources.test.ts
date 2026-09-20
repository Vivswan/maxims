// What would drift silently: a source argument that makes the grammar THROW a plain Error instead
// of a usage refusal, a parsed source the state schema then refuses (an `add` that writes a state
// file the next run quarantines), or a remote URL whose host, port or segments come back in a
// shape the store-path derivation never expected.
import { expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import fc from "fast-check";
import { isUsableRemote, parseRemote, SourceFromSchema } from "../../src/contracts/source.ts";
import {
  canonicalSourceKey,
  parseSourceArgument,
  parseSourceSelector,
} from "../../src/state/schema.ts";
import { ExitCode, MaximsError } from "../../src/util/exit-codes.ts";
import { PROPERTY_TIMEOUT_MS } from "../shared/property.ts";
import { anyText, describeError, fragments, fuzz, outcome } from "./shared.ts";

const CWD = "/home/user/project";

// Fragments of every accepted spelling: the shorthand, the four URL schemes, the scp-like form,
// GitHub tree URLs, enterprise and tenancy hosts, pins, memory suffixes and local path prefixes,
// with the characters the marker and segment rules refuse.
const SOURCE_PIECES = [
  "@",
  "owner",
  "Owner",
  "repo",
  "rules",
  "/",
  "//",
  ".git",
  "https://",
  "http://",
  "ssh://",
  "git://",
  "file://",
  "ftp://",
  "git@",
  "user@",
  "github.com",
  "GitHub.com",
  "api.github.com",
  "www.github.com",
  "github.localhost",
  "octo.ghe.com",
  "api.octo.ghe.com",
  "gitlab.example.com",
  "localhost",
  ":",
  "22",
  "443",
  "/tree/",
  "main",
  "release/1.0",
  "v2",
  "#",
  "#v2",
  "@memory-name",
  "@Not_Kebab",
  "%2F",
  "%",
  "%zz",
  "..",
  ".",
  "./",
  "../",
  "~",
  "~/",
  "C:\\",
  "C:/",
  "\\",
  "?",
  "q=1",
  "-",
  "_",
  " ",
  "\n",
  "\t",
  "\0",
  "-->",
  "[::1]",
  "a",
  "0",
];

const sourceArg = fc.oneof(
  anyText({ maxLength: 120 }),
  fragments(SOURCE_PIECES, { maxLength: 12 }),
  fc.webUrl({ withFragments: true, withQueryParameters: true }),
  fc.stringMatching(/^@?[A-Za-z0-9._-]{0,10}\/[A-Za-z0-9._-]{0,10}(@[a-z0-9-]{0,8})?$/),
);

const ghHost = fc.option(
  fc.oneof(
    fc.constantFrom(
      "github.com",
      "GITHUB.COM",
      "api.github.com",
      "octo.ghe.com",
      "api.octo.ghe.com",
      "ghe.example.com",
      "not a host",
      "",
    ),
    anyText({ maxLength: 30 }),
  ),
  { nil: undefined },
);

const selectorInput = fc.record({ arg: sourceArg, ghHost });

function usageOnly(error: unknown): void {
  if (error instanceof MaximsError && error.code === ExitCode.Usage) return;
  throw new Error(`threw ${describeError(error)}`);
}

// The one boundary a typed source is minted at: whatever comes back is a `SourceFrom` state can
// hold, keyed by a canonical key that is a non-empty single-line string.
function expectStorable(from: unknown): void {
  const stored = SourceFromSchema.safeParse(from);
  if (!stored.success) {
    throw new Error(
      `parsed source is not storable: ${JSON.stringify(from)}: ${stored.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  const key = canonicalSourceKey(stored.data);
  expect(key).not.toBe("");
  expect(key).not.toMatch(/[\r\n]/);
}

test(
  "parseSourceSelector answers a selector or a usage refusal for any argument and GH_HOST",
  async () => {
    await fuzz("parseSourceSelector", selectorInput, ({ arg, ghHost }) => {
      const options = ghHost === undefined ? {} : { ghHost };
      const result = outcome(() => parseSourceSelector(arg, CWD, options));
      if (result.kind === "threw") return usageOnly(result.error);
      const { from, memory } = result.value;
      // The two fields the grammar mints but does not finish are judged at the add door: the local
      // path once it is resolved to its real path, the ref once `--pin` has had its say. Every
      // other field is stored as parsed, so it must already be storable here.
      if (from.type !== "local") expectStorable({ ...from, ref: "HEAD" });
      if (memory !== null) expect(memory).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      if (from.type === "github") {
        expect(from.repo).toMatch(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);
        if (from.host !== undefined) expect(from.host).toBe(from.host.toLowerCase());
        expect(from.host).not.toBe("github.com");
      }
      if (from.type === "git") expect(isUsableRemote(from.url)).toBe(true);
      if (from.type === "local") expect(isAbsolute(from.path)).toBe(true);
      const whole = outcome(() => parseSourceArgument(arg, CWD, options));
      if (memory === null) expect(whole).toEqual({ kind: "value", value: from });
      else if (whole.kind === "threw") usageOnly(whole.error);
      else throw new Error(`a memory selector passed as a whole source: ${arg}`);
    });
  },
  PROPERTY_TIMEOUT_MS,
);

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

// A usable segment is a real directory name: no separator, no pin character, no control byte.
function hasSeparatorOrControl(segment: string): boolean {
  for (const char of segment) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || "/\\@#".includes(char)) return true;
  }
  return false;
}

const remoteUrl = fc.oneof(
  anyText({ maxLength: 120 }),
  fragments(SOURCE_PIECES, { maxLength: 12 }),
  fc.webUrl({ withFragments: true, withQueryParameters: true }),
);

test(
  "parseRemote answers null or a lower-cased host with trimmed segments for any URL",
  async () => {
    await fuzz("parseRemote", remoteUrl, (url) => {
      const result = outcome(() => parseRemote(url));
      if (result.kind === "threw") throw new Error(`threw ${describeError(result.error)}`);
      const remote = result.value;
      const usable = outcome(() => isUsableRemote(url));
      if (usable.kind === "threw") throw new Error(`threw ${describeError(usable.error)}`);
      if (remote === null) {
        expect(usable.value).toBe(false);
        return;
      }
      expect(remote.host).toBe(remote.host.toLowerCase());
      expect(remote.host).not.toContain("@");
      if (remote.port !== null) expect(remote.port).toMatch(/^\d+$/);
      expect(remote.segments[0]).not.toBe("");
      expect(remote.segments.at(-1)).not.toBe("");
      expect(url).not.toContain("#");
      if (usable.value) {
        expect(remote.host).toMatch(HOSTNAME);
        expect(remote.segments.length).toBeGreaterThan(0);
        for (const segment of remote.segments) expect(hasSeparatorOrControl(segment)).toBe(false);
      }
    });
  },
  PROPERTY_TIMEOUT_MS,
);
