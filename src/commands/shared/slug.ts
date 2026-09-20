import { basename, resolve } from "node:path";
import {
  canonicalSourceKey,
  DEFAULT_GIT_REF,
  parseRemote,
  type SourceFrom,
  stripGitSuffix,
} from "../../state/schema.ts";
import { sha256 } from "../../util/fs.ts";

const SLUG_HASH_LENGTH = 6;
// A hashed slug's readable part is cut so `maxims-<slug>.md` stays far under the 255-byte file
// name limit whatever the pin or path; the hash carries the identity.
const READABLE_MAX = 80;

// The file-name form of a source: `maxims-<slug>.md` in a rules directory. A GitHub source whose
// owner and repository are plain alphanumerics reads as `owner-repo`; every other key carries a
// hash of the exact key behind a double dash, because its readable form could stand for another
// key too (a dash or a dot inside a segment, a pin, a host, a local path). A clean slug never
// holds `--` and a hashed one always does, so the two forms never meet.
export function sourceSlug(from: SourceFrom): string {
  const segments = readableSegments(from);
  const readable = segments.map((segment) => segment.toLowerCase()).join("-");
  const clean =
    from.type === "github" &&
    from.host === undefined &&
    from.ref === DEFAULT_GIT_REF &&
    segments.every((segment) => /^[A-Za-z0-9]+$/.test(segment));
  if (clean) return readable;
  const folded = fold(readable).slice(0, READABLE_MAX).replace(/-+$/, "");
  const digest = sha256(canonicalSourceKey(from));
  return `${folded}--${digest.slice("sha256:".length, "sha256:".length + SLUG_HASH_LENGTH)}`;
}

function readableSegments(from: SourceFrom): string[] {
  switch (from.type) {
    case "github": {
      const parts = from.host === undefined ? [] : [from.host];
      parts.push(...from.repo.split("/"));
      return withPin(parts, from.ref);
    }
    case "git": {
      const remote = parseRemote(from.url);
      if (remote === null) return withPin([from.url], from.ref);
      const segments = [...remote.segments];
      const last = segments.length - 1;
      segments[last] = stripGitSuffix(segments[last] ?? "");
      const host = remote.port === null ? remote.host : `${remote.host}_${remote.port}`;
      return withPin([host, ...segments], from.ref);
    }
    case "local": {
      const absolute = resolve(from.path);
      return ["local", basename(absolute) || "root"];
    }
  }
}

function withPin(segments: string[], ref: string): string[] {
  return ref === DEFAULT_GIT_REF ? segments : [...segments, ref];
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
