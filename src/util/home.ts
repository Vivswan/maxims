import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { SourceFrom } from "../state/schema.ts";
import { assertInsideRoot, sha256 } from "./fs.ts";

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
};

// `lastSync` is the stamp the per-prompt hooks (Cursor, Windsurf) debounce on; a session-start hook
// never reads it.
export function homePaths(home: string): HomePaths {
  return {
    store: join(home, "store"),
    state: join(home, "state.json"),
    lock: join(home, "state.json.lock"),
    log: join(home, "log", "refresh.log"),
    lastSync: join(home, "last-sync"),
  };
}

// GitHub owner and repo names are case-insensitive, so the store folds them to lower case: two
// spellings of one repo must land in one entry even on a case-sensitive filesystem. The `_local`
// prefix is unreachable for a github owner, whose names never start with an underscore.
export function storePathFor(home: string, from: SourceFrom): string {
  const store = homePaths(home).store;
  if (from.type === "github") {
    const [owner, repo] = from.repo.toLowerCase().split("/", 2);
    return assertInsideRoot(store, join(store, owner ?? "", repo ?? ""));
  }
  const absolute = resolve(from.path);
  const stem = basename(absolute) || "root";
  const digest = sha256(absolute).slice("sha256:".length, "sha256:".length + 8);
  return assertInsideRoot(store, join(store, "_local", `${stem}-${digest}`));
}
