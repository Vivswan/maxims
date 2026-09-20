import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DEFAULT_GIT_REF, parseRemote, type SourceFrom, stripGitSuffix } from "../state/schema.ts";
import { ExitCode, MaximsError } from "./exit-codes.ts";
import { assertInsideRoot, type RootedPath, sha256 } from "./fs.ts";

/** @public */
export function maximsHome(env: Record<string, string | undefined>): string {
  const override = env.MAXIMS_HOME;
  if (override !== undefined && override !== "") return resolve(override);
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return join(home, ".agents", "maxims");
}

export type HomePaths = {
  store: string;
  state: string;
  lock: string;
  log: string;
  lastSync: string;
  config: string;
};

// `lastSync` is the universal quiet-mode debounce stamp: every `sync --quiet` run, whichever hook
// fired it, exits 0 without work while the stamp is younger than 60 seconds.
export function homePaths(home: string): HomePaths {
  return {
    store: join(home, "store"),
    state: join(home, "state.json"),
    lock: join(home, "state.json.lock"),
    log: join(home, "log", "refresh.log"),
    lastSync: join(home, "last-sync"),
    config: join(home, "config.json"),
  };
}

// GitHub owner and repo names are case-insensitive, so the store folds them to lower case: two
// spellings of one repo must land in one entry even on a case-sensitive filesystem. The `_local`,
// `_git` and `_github` prefixes are unreachable for a github owner, whose names never start with an
// underscore; a git remote keys on its host and path with `.git` stripped and slashes kept, and
// an explicit port joins the host with `_` because `:` is not a portable directory character. A
// pinned source is a distinct source, so its entry carries the pin as a suffix.
// A ref may hold characters a directory name cannot (`release/1.0`), so the readable form is
// sanitized and capped well under NAME_MAX, and a short hash of the exact ref keeps two refs that
// sanitize or truncate alike apart.
const PIN_READABLE_MAX = 40;

function pinned(name: string, ref: string): string {
  if (ref === DEFAULT_GIT_REF) return name;
  const readable = ref.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, PIN_READABLE_MAX);
  const digest = sha256(ref).slice("sha256:".length, "sha256:".length + 8);
  return `${name}@${readable}-${digest}`;
}

// The one derivation of a source's store entry, proven inside the store root here so every store
// write takes the result as is.
export function storePathFor(home: string, from: SourceFrom): RootedPath {
  const store = homePaths(home).store;
  if (from.type === "github") {
    const [owner = "", repo = ""] = from.repo.toLowerCase().split("/", 2);
    const prefix = from.host === undefined ? [] : ["_github", from.host];
    return assertInsideRoot(store, join(store, ...prefix, owner, pinned(repo, from.ref)));
  }
  if (from.type === "git") {
    const remote = parseRemote(from.url);
    if (remote === null) {
      throw new MaximsError(ExitCode.SourceUnresolvable, `${from.url} is not a git remote URL`);
    }
    const segments = [...remote.segments];
    const last = segments.length - 1;
    segments[last] = pinned(stripGitSuffix(segments[last] ?? ""), from.ref);
    const host = remote.port === null ? remote.host : `${remote.host}_${remote.port}`;
    return assertInsideRoot(store, join(store, "_git", host, ...segments));
  }
  const absolute = resolve(from.path);
  const stem = basename(absolute) || "root";
  const digest = sha256(absolute).slice("sha256:".length, "sha256:".length + 8);
  return assertInsideRoot(store, join(store, "_local", `${stem}-${digest}`));
}
