import { z } from "zod";

declare const gitShaBrand: unique symbol;

// What a git remote reports as a commit id. A copied local source has no commit and records a
// content hash instead, so the two are distinct brands, never one `string`.
export type GitSha = string & { readonly [gitShaBrand]: true };

// The one sha grammar (zod's sha-1 hex digest): the resolvers' full-sha short-circuit, the ladder's
// reading of a remote's answer and the state schema all parse through here. Either case is accepted
// because a user may type a pin in upper case; the lower-cased form is what state records and
// compares, so two spellings of one commit never read as a change.
export function parseGitSha(candidate: string): GitSha | null {
  return z.regexes.sha1_hex.test(candidate) ? (candidate.toLowerCase() as GitSha) : null;
}
