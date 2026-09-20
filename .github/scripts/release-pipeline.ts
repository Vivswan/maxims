/**
 * The npm release pipeline. The built cli reaches consumers through npm alone, from two lanes that share the
 * npm-publish concurrency group and publish through trusted publishing (OIDC, no registry token):
 *
 *   next    post-green.yml      every green main push   -> X.Y.(Z+1)-main.<count>.<yyyymmdd>.g<sha7> under the next dist-tag
 *   stable  update-release.yml  each release-please tag -> package.json's X.Y.Z, moving latest
 *
 * One subcommand runs per workflow step; the checkout must be at GITHUB_SHA, the commit whose build is published:
 *
 *   prerelease-version      GITHUB_SHA
 *   npm-verdict next        GITHUB_SHA, NPM_REGISTRY_URL (optional)
 *   npm-verdict stable      TAG, GITHUB_SHA, NPM_REGISTRY_URL (optional)
 *   npm-confirm next        GITHUB_SHA, NPM_REGISTRY_URL (optional), NPM_CONFIRM_PAUSE_MS (optional)
 *   npm-confirm stable      TAG, GITHUB_SHA, NPM_REGISTRY_URL (optional), NPM_CONFIRM_PAUSE_MS (optional)
 *
 * Depends on semver, so both workflows run bun install before calling it. Tests: tests/release/*.test.ts.
 */

import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { gt, parse } from "semver";

const MANIFEST = "package.json";
const FULL_SHA = /^[0-9a-f]{40}$/;
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
/** npm makes a publish readable asynchronously, at times minutes after npm publish returned; 15 reads 20 s apart
 * bound the wait at 280 s. */
const CONFIRM_READS = 15;
const CONFIRM_PAUSE_MS = 20_000;

export type Channel = "next" | "stable";

function gitFailure(args: string[], error: unknown): Error {
  const stderr = (error as { stderr?: unknown }).stderr;
  const detail = typeof stderr === "string" && stderr.trim() !== "" ? `: ${stderr.trim()}` : "";
  return new Error(`git ${args.join(" ")} failed${detail}`);
}

function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw gitFailure(args, error);
  }
}

/** git's stdout, or null when it exited 1 (a "no" from --verify or --is-ancestor); any other failure is thrown,
 * so a repository git cannot read never passes for one without the object. */
function gitOrNo(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) {
      return null;
    }
    throw gitFailure(args, error);
  }
}

/** The git facts a verdict needs, so a verdict can be judged against a hand-built history. */
export interface Ancestry {
  /** The full sha `name` resolves to as a commit, or null when the history lacks it. */
  resolveCommit(name: string): string | null;
  /** Whether `ancestor` is `descendant` or reachable from it; both are resolved shas. */
  isAncestor(ancestor: string, descendant: string): boolean;
}

export function gitAncestry(cwd: string): Ancestry {
  return {
    resolveCommit: (name) => gitOrNo(cwd, "rev-parse", "--verify", "--quiet", `${name}^{commit}`),
    isAncestor: (ancestor, descendant) =>
      gitOrNo(cwd, "merge-base", "--is-ancestor", ancestor, descendant) !== null,
  };
}

export interface MainPosition {
  /** Commits reachable from it along first parents: one more per merge to main, whatever a merged PR's branch held. */
  count: number;
  /** Its committer date in UTC, YYYYMMDD. */
  date: string;
}

/** Refused on a shallow checkout: it would count to its boundary and mint a truncated count, so the version would
 * sort below ones minted from the full history for older commits. */
export function mainPosition(cwd: string, sourceSha: string): MainPosition {
  if (git(cwd, "rev-parse", "--is-shallow-repository") === "true") {
    throw new Error(
      "the pre-release version needs the full history (fetch-depth: 0) and this checkout is shallow: the count of commits under the source would stop at the shallow boundary.",
    );
  }
  const count = Number(git(cwd, "rev-list", "--count", "--first-parent", sourceSha));
  const committed = Number(git(cwd, "show", "-s", "--format=%ct", sourceSha));
  const date = new Date(committed * 1000).toISOString().slice(0, 10).replaceAll("-", "");
  return { count, date };
}

/**
 * The npm version a green main commit publishes under the `next` dist-tag: the manifest version's next patch,
 * then `main`, the source's position on main, and its short sha. That sorts above the last release, below the
 * next one whatever its bump, and along main: npm compares the count first, and it grows by one with each merge
 * (the date is for the reader; two merges on one day share it). The sha carries a `g` prefix, as git describe
 * writes it: npm reads an all-digit identifier as a number and drops its leading zero, so a bare sha7 such as
 * 0123456 would be rewritten to 123456 and name no commit.
 */
export function prereleaseVersion(
  manifestVersion: string,
  position: MainPosition,
  sourceSha: string,
): string {
  const version = parse(manifestVersion);
  // parse also reads "v1.2.3" and "1.2.3-rc.1"; the manifest must be the bare release it is about to bump.
  if (version === null || version.version !== manifestVersion || version.prerelease.length > 0) {
    throw new Error(
      `the manifest version ${JSON.stringify(manifestVersion)} is not X.Y.Z; refusing to derive a pre-release version from it.`,
    );
  }
  // The first commit counts 1, so a count of 0 names no commit; a version carrying one was never minted here.
  if (!Number.isInteger(position.count) || position.count < 1) {
    throw new Error(
      `the commit count ${JSON.stringify(position.count)} is not a positive integer; refusing to mint a pre-release version from it.`,
    );
  }
  if (!FULL_SHA.test(sourceSha)) {
    throw new Error(
      `the source ${JSON.stringify(sourceSha)} is not a full commit sha; refusing to mint a pre-release version from it.`,
    );
  }
  const { major, minor, patch } = version;
  return `${major}.${minor}.${patch + 1}-main.${position.count}.${position.date}.g${sourceSha.slice(0, 7)}`;
}

function packageFieldAt(cwd: string, treeish: string, field: "name" | "version"): string {
  const pkg = JSON.parse(git(cwd, "show", `${treeish}:${MANIFEST}`)) as Record<string, unknown>;
  return String(pkg[field]);
}

/** The checkout must be at the source whose build is published: package.json is read there. */
function assertCheckoutAt(cwd: string, sourceSha: string): void {
  const head = git(cwd, "rev-parse", "HEAD");
  if (head !== sourceSha) {
    throw new Error(
      `the checkout is at ${head}, not the source commit ${sourceSha} whose build is published.`,
    );
  }
}

function prereleaseVersionOf(cwd: string, sourceSha: string): string {
  assertCheckoutAt(cwd, sourceSha);
  return prereleaseVersion(
    packageFieldAt(cwd, sourceSha, "version"),
    mainPosition(cwd, sourceSha),
    sourceSha,
  );
}

/** The version npm publishes for a release: package.json's, which must be the tag's, so a hand recovery with the
 * wrong TAG or a draft pointing at the wrong commit publishes nothing. */
function releaseVersionAt(cwd: string, sourceSha: string, tag: string): string {
  assertCheckoutAt(cwd, sourceSha);
  const version = packageFieldAt(cwd, sourceSha, "version");
  if (`v${version}` !== tag) {
    throw new Error(
      `${MANIFEST} at the release source is version ${version}, but the release tag is ${tag}; refusing to publish a version this source did not release.`,
    );
  }
  return version;
}

/** A version this pipeline mints, parsed: a release, or a pre-release carrying its source's short sha. The
 * identifiers between `main` and the sha are not read back: a published pre-release is placed by its source's
 * ancestry, never by comparing them. */
interface MintedVersion {
  /** The release, X.Y.Z, that the version is or precedes. */
  release: string;
  sha7: string | null;
}

/** semver reads a numeric identifier as a number and anything else as a string, so `main` and the g-prefixed sha
 * stay strings and the count and date between them are numbers. */
function mintedVersion(version: string): MintedVersion | null {
  const parsed = parse(version);
  if (parsed === null || parsed.version !== version) {
    return null;
  }
  const release = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  const identifiers = parsed.prerelease;
  if (identifiers.length === 0) {
    return { release, sha7: null };
  }
  const last = identifiers.at(-1);
  const sha7 = typeof last === "string" ? last.match(/^g([0-9a-f]{7})$/)?.[1] : undefined;
  const placed =
    identifiers[0] === "main" &&
    identifiers.length >= 3 &&
    identifiers.slice(1, -1).every((identifier) => typeof identifier === "number");
  return placed && sha7 !== undefined ? { release, sha7 } : null;
}

/** A version a dist-tag names must be one this pipeline mints; anything else stops the run rather than being guessed at. */
function parseMinted(version: string): MintedVersion {
  const minted = mintedVersion(version);
  if (minted === null) {
    throw new Error(
      `${JSON.stringify(version)} is not a version this pipeline mints (X.Y.Z or X.Y.Z-main.<position>.g<sha7>); refusing to order it.`,
    );
  }
  return minted;
}

/** What the registry holds for the package: every published version, and where each dist-tag points. */
export interface Packument {
  versions: Record<string, unknown>;
  "dist-tags": Record<string, string>;
}

/** A record this pipeline cannot read. Never retried: a registry that answers with one is not going to answer
 * with a packument a moment later, so the run stops instead of passing it for an empty record and publishing blind. */
export class UnreadablePackument extends Error {}

export function parsePackument(body: unknown, describe: string): Packument {
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!record(body) || !record(body.versions) || !record(body["dist-tags"])) {
    throw new UnreadablePackument(
      `${describe} is not a packument (an object with versions and dist-tags records); refusing to publish without knowing what the registry holds.`,
    );
  }
  const tags = body["dist-tags"];
  for (const [tag, value] of Object.entries(tags)) {
    if (typeof value !== "string") {
      throw new UnreadablePackument(
        `${describe} names dist-tag ${tag} as ${JSON.stringify(value)}, not a version; refusing to publish without knowing what the registry holds.`,
      );
    }
  }
  return { versions: body.versions, "dist-tags": tags as Record<string, string> };
}

/** The registry's record of `name`, or null while it has never been published; any other answer than 200 or 404 throws.
 * The URL carries a fresh query string on every read: the registry's CDN serves a packument from cache for up to
 * 300 s (cache-control: public, max-age=300, and a request's no-cache is ignored), and a cache key that no earlier
 * request had misses it, so the record comes from the origin, a publish just landed included. */
async function fetchPackument(registry: string, name: string): Promise<Packument | null> {
  const url = `${registry.replace(/\/$/, "")}/${name.replaceAll("/", "%2F")}`;
  const response = await fetch(
    `${url}?fresh=${Date.now()}-${Math.random().toString(36).slice(2)}`,
    { headers: { accept: "application/json" } },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `the registry answered ${response.status} for ${name} (${url}); refusing to publish without knowing what it holds.`,
    );
  }
  const describe = `the registry's record of ${name} (${url})`;
  // The body is read whole before it is parsed: a connection cut mid-body is a transport failure, retried
  // like any other, and only a body that arrived and is not JSON is unreadable.
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new UnreadablePackument(
      `${describe} is not JSON (${error instanceof Error ? error.message : String(error)}); refusing to publish without knowing what the registry holds.`,
    );
  }
  return parsePackument(body, describe);
}

/**
 *   publish  -> the version is not on the registry and nothing newer holds the lane's dist-tag: npm publish goes
 *   present  -> the version is already on the registry (a rerun): nothing is published, the dist-tag is still confirmed
 *   skip     -> publishing would move the lane's dist-tag back; the reason says what holds it
 */
export type PublishVerdict =
  | { action: "publish" | "present"; version: string }
  | { action: "skip"; version: string; reason: string };
/** The next channel's verdict also carries, one line each, the published pre-releases it set aside: a source the checkout cannot place. */
export type NextVerdict = PublishVerdict & { notices: string[] };

/** A published pre-release whose source is a strict descendant of this run's: newer on main, whatever its numbers say. */
interface Descendant {
  version: string;
  /** The full sha the version's sha7 resolved to. */
  sha: string;
}

/** The published pre-releases placed against this run's source by ancestry: the descendants, the one furthest along
 * main, and a notice for each the checkout cannot place (a sha it lacks, or one off the source's line of main). */
function descendantsOf(
  ancestry: Ancestry,
  sourceSha: string,
  packument: Packument,
): { descendants: Descendant[]; newest: Descendant | null; notices: string[] } {
  const descendants: Descendant[] = [];
  const notices: string[] = [];
  let newest: Descendant | null = null;
  for (const version of Object.keys(packument.versions)) {
    const sha7 = mintedVersion(version)?.sha7;
    if (sha7 === null || sha7 === undefined) {
      continue;
    }
    const sha = ancestry.resolveCommit(sha7);
    if (sha === null) {
      notices.push(`${version} names ${sha7}, which is no commit in this checkout; ignored`);
    } else if (sha !== sourceSha && ancestry.isAncestor(sourceSha, sha)) {
      descendants.push({ version, sha });
      if (newest === null || ancestry.isAncestor(newest.sha, sha)) {
        newest = { version, sha };
      }
    } else if (sha !== sourceSha && !ancestry.isAncestor(sha, sourceSha)) {
      notices.push(
        `${version} names ${sha7}, which is neither an ancestor nor a descendant of ${sourceSha.slice(0, 7)} on main; ignored`,
      );
    }
  }
  return { descendants, newest, notices };
}

/**
 * Every published pre-release is placed by its source's ancestry, so a run for an older commit publishes nothing
 * once a newer commit's pre-release is on the registry, whatever order the two runs finished in (`npm publish --tag
 * next` moves next to whatever it publishes). The dist-tags need no separate read: whatever next names is among
 * the versions. Null is a package the registry has never seen: the first publish goes.
 */
export function nextPublishVerdict(
  ancestry: Ancestry,
  sourceSha: string,
  version: string,
  packument: Packument | null,
): NextVerdict {
  if (packument === null) {
    return { action: "publish", version, notices: [] };
  }
  if (version in packument.versions) {
    return { action: "present", version, notices: [] };
  }
  const { newest: newer, notices } = descendantsOf(ancestry, sourceSha, packument);
  if (newer !== null) {
    return {
      action: "skip",
      version,
      reason: `the registry already holds ${newer.version}, whose source ${newer.sha.slice(0, 7)} is a descendant of ${sourceSha.slice(0, 7)} on main, so this stale run publishes nothing (npm publish --tag next would move next back)`,
      notices,
    };
  }
  return { action: "publish", version, notices };
}

/**
 * Only `latest` is consulted: a plain `npm publish` moves latest and leaves next alone, and a release is meant to
 * sort below the pre-releases that followed its merge (the merge commit's own run publishes the next patch's
 * pre-release before this job runs).
 */
export function stablePublishVerdict(version: string, packument: Packument | null): PublishVerdict {
  if (packument === null) {
    return { action: "publish", version };
  }
  if (version in packument.versions) {
    return { action: "present", version };
  }
  const latest = packument["dist-tags"].latest;
  // Until the first release, latest names a pre-release: a packument always carries that key (npm/registry
  // REGISTRY-API.md, "dist-tags: an object with at least one key, latest"), so the first publish took it whatever
  // --tag asked for. A release must take latest over from it, so only a newer RELEASE holds one back.
  const held = latest === undefined ? null : parseMinted(latest);
  if (held?.sha7 === null && gt(held.release, parseMinted(version).release)) {
    return {
      action: "skip",
      version,
      reason: `the registry's latest is ${latest}, newer than ${version}, so this rerun of an older release publishes nothing (npm publish would move latest back)`,
    };
  }
  return { action: "publish", version };
}

export type NpmVerdictOptions = {
  cwd: string;
  /** The commit whose build is published; the checkout must be at it. */
  sourceSha: string;
  /** The registry's base URL, where the package's record is read. */
  registry: string;
} & ({ channel: "next" } | { channel: "stable"; tag: string });

export async function npmVerdict(
  options: NpmVerdictOptions,
): Promise<NextVerdict | PublishVerdict> {
  const { cwd, sourceSha, registry } = options;
  const version =
    options.channel === "next"
      ? prereleaseVersionOf(cwd, sourceSha)
      : releaseVersionAt(cwd, sourceSha, options.tag);
  const packument = await fetchPackument(registry, packageFieldAt(cwd, sourceSha, "name"));
  return options.channel === "next"
    ? nextPublishVerdict(gitAncestry(cwd), sourceSha, version, packument)
    : stablePublishVerdict(version, packument);
}

export type ConfirmVerdict =
  /** The registry's record shows the version this run published, and the lane's dist-tag is where it should be. */
  | { outcome: "settled"; version: string; reads: number }
  /** The record still lacks the version after every read: a following run may read one without it. */
  | { outcome: "unsettled"; version: string; reason: string }
  /** The record shows the version, and the lane's dist-tag names an older one than it should. */
  | { outcome: "behind"; version: string; reason: string };

export interface ConfirmPublishOptions {
  channel: Channel;
  /** The package's name and the version this run published; the record is read until it shows the version. */
  name: string;
  version: string;
  /** The commit whose build was published; the next channel places the record's pre-releases against it. */
  sourceSha: string;
  ancestry: Ancestry;
  /** One read of the registry's record; a read that fails counts as one that did not show the version, unless
   * the record itself is unreadable. */
  readPackument: () => Promise<Packument | null>;
  /** How many times the record is read while it lacks the version, and the pause between reads. */
  attempts: number;
  pause: () => Promise<void>;
}

/**
 * After a publish, or on a rerun that found the version present: the record is read until it shows the version, so
 * the job holds the npm-publish lane until the next holder's verdict can see this publish (npm makes a publish
 * readable asynchronously; a verdict read in that gap would move a dist-tag back). Once it shows, the lane's
 * dist-tag is judged:
 *
 *   next    -> must name this version or a descendant's pre-release, or a stale run moved it back
 *   stable  -> must name this release or a newer one, or an older release's publish moved it back
 *
 * A drift is reported, not repaired: trusted publishing (OIDC) authenticates `npm publish` alone, not `npm dist-tag
 * add` (npm/cli#8547). The next publish on the lane moves the tag forward, or a hand `npm dist-tag add` does; a
 * rerun then confirms and passes.
 */
export async function confirmPublish(options: ConfirmPublishOptions): Promise<ConfirmVerdict> {
  const { channel, name, version, sourceSha, ancestry, readPackument, attempts, pause } = options;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`the read attempts must be a positive integer, not ${attempts}`);
  }
  for (let read = 1; ; read++) {
    // A read that fails counts as a read that did not show the version: the lane is held through the budget
    // either way, and the last failure is the one reported.
    let packument: Packument | null;
    try {
      packument = await readPackument();
    } catch (error) {
      if (error instanceof UnreadablePackument || read === attempts) {
        throw error;
      }
      await pause();
      continue;
    }
    if (packument !== null && version in packument.versions) {
      const behind =
        channel === "next"
          ? nextBehind(ancestry, sourceSha, version, name, packument)
          : stableBehind(version, name, packument);
      return behind === null
        ? { outcome: "settled", version, reads: read }
        : { outcome: "behind", version, reason: behind };
    }
    if (read === attempts) {
      return {
        outcome: "unsettled",
        version,
        reason: `the registry's record still lacks ${version} after ${attempts} reads; a run judged before it shows may move ${channel === "next" ? "next" : "latest"} back, and the next publish on the lane moves it forward`,
      };
    }
    await pause();
  }
}

function nextBehind(
  ancestry: Ancestry,
  sourceSha: string,
  version: string,
  name: string,
  packument: Packument,
): string | null {
  const { descendants, newest } = descendantsOf(ancestry, sourceSha, packument);
  const next = packument["dist-tags"].next;
  const forwardEnough =
    newest === null ? next === version : descendants.some((d) => d.version === next);
  if (forwardEnough) {
    return null;
  }
  const forward = newest?.version ?? version;
  return (
    `the registry's next is ${next ?? "unset"} while it holds ${forward}${newest === null ? "" : `, whose source ${newest.sha.slice(0, 7)} is a descendant of ${sourceSha.slice(0, 7)} on main`}; ` +
    `a stale run moved next back, and the next green push moves it forward (npm dist-tag add ${name}@${forward} next repairs it by hand)`
  );
}

function stableBehind(version: string, name: string, packument: Packument): string | null {
  const latest = packument["dist-tags"].latest;
  const held = latest === undefined ? null : parseMinted(latest);
  if (
    held !== null &&
    held.sha7 === null &&
    (latest === version || gt(held.release, parseMinted(version).release))
  ) {
    return null;
  }
  return `the registry's latest is ${latest ?? "unset"} while it holds ${version}, a release; something moved latest back, and the next release moves it forward (npm dist-tag add ${name}@${version} latest repairs it by hand)`;
}

export interface NpmConfirmOptions {
  cwd: string;
  /** The commit whose build this run published; the checkout must be at it. */
  sourceSha: string;
  /** The registry's base URL, where the package's record is read. */
  registry: string;
  delayMs: number;
}

export async function npmConfirm(
  options: NpmConfirmOptions & ({ channel: "next" } | { channel: "stable"; tag: string }),
): Promise<ConfirmVerdict> {
  const { cwd, sourceSha, registry, delayMs } = options;
  const version =
    options.channel === "next"
      ? prereleaseVersionOf(cwd, sourceSha)
      : releaseVersionAt(cwd, sourceSha, options.tag);
  const name = packageFieldAt(cwd, sourceSha, "name");
  return confirmPublish({
    channel: options.channel,
    name,
    version,
    sourceSha,
    ancestry: gitAncestry(cwd),
    readPackument: () => fetchPackument(registry, name),
    attempts: CONFIRM_READS,
    pause: () => sleep(delayMs),
  });
}

/** The pause between confirm reads: NPM_CONFIRM_PAUSE_MS when set (a hand run against a local registry needs no wait), else CONFIRM_PAUSE_MS. */
function confirmPauseMs(value: string | undefined): number {
  if (value === undefined || value === "") {
    return CONFIRM_PAUSE_MS;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `NPM_CONFIRM_PAUSE_MS must be a whole number of milliseconds, not ${JSON.stringify(value)}`,
    );
  }
  return Number(value);
}

function channelOf(command: string, argument: string | undefined): Channel {
  if (argument !== "next" && argument !== "stable") {
    throw new Error(
      `${command} takes the channel, next or stable, not ${JSON.stringify(argument ?? null)}`,
    );
  }
  return argument;
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const [command, argument] = process.argv.slice(2);
  const env = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === "") {
      throw new Error(`${name} is required for "${command}"`);
    }
    return value;
  };
  const lane = (channel: Channel) =>
    channel === "next" ? { channel } : { channel, tag: env("TAG") };
  switch (command) {
    case "prerelease-version": {
      console.log(prereleaseVersionOf(cwd, env("GITHUB_SHA")));
      break;
    }
    case "npm-verdict": {
      const verdict = await npmVerdict({
        cwd,
        sourceSha: env("GITHUB_SHA"),
        registry: process.env.NPM_REGISTRY_URL || DEFAULT_REGISTRY,
        ...lane(channelOf(command, argument)),
      });
      for (const notice of "notices" in verdict ? verdict.notices : []) {
        console.error(notice);
      }
      console.log(
        verdict.action === "skip"
          ? `skip ${verdict.reason}`
          : `${verdict.action} ${verdict.version}`,
      );
      break;
    }
    case "npm-confirm": {
      const channel = channelOf(command, argument);
      const confirmed = await npmConfirm({
        cwd,
        sourceSha: env("GITHUB_SHA"),
        registry: process.env.NPM_REGISTRY_URL || DEFAULT_REGISTRY,
        delayMs: confirmPauseMs(process.env.NPM_CONFIRM_PAUSE_MS),
        ...lane(channel),
      });
      console.log(
        confirmed.outcome === "settled"
          ? `settled ${confirmed.version} is on the registry after ${confirmed.reads} ${confirmed.reads === 1 ? "read" : "reads"}; ${channel === "next" ? "next is not behind a descendant's pre-release" : "latest names it or a newer release"}`
          : `${confirmed.outcome} ${confirmed.reason}`,
      );
      break;
    }
    default:
      throw new Error(
        `unknown command ${JSON.stringify(command ?? null)}; expected prerelease-version | npm-verdict <next|stable> | npm-confirm <next|stable>`,
      );
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      `release-pipeline ${process.argv[2] ?? ""}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
