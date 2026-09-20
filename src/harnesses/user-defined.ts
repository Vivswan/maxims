import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { flattenIssues } from "../util/zod-issues.ts";
import { HARNESS_IDS, type HarnessDefinition } from "./contract.ts";
import { toDefinition } from "./from-spec.ts";
import { parseHarnessSpec, UserHarnessSpecSchema } from "./spec.ts";

// A harness the user declared in `$MAXIMS_HOME/harnesses.json`, so `list` and `doctor` can label
// it as theirs rather than as one maxims ships and verifies.
export type UserDefinedHarness = HarnessDefinition & { userDefined: true };

const USER_HARNESSES_FILE = "harnesses.json";

// The file is an object with one `harnesses` array rather than a bare array, so a future key
// beside it (a format version, shared defaults) has a place without breaking every existing file.
const UserHarnessesFile = z.strictObject({ harnesses: z.array(z.unknown()) });

function userHarnessesPath(home: string): string {
  return join(home, USER_HARNESSES_FILE);
}

// A missing file is the common case and means no user-defined harnesses; anything else that stops
// the file from loading is refused with the entry and field named, because a half-loaded list
// would silently drop a harness the user expects `sync` to write.
export async function loadUserDefinedHarnesses(home: string): Promise<UserDefinedHarness[]> {
  const path = userHarnessesPath(home);
  const text = await readIfPresent(path);
  if (text === null) return [];
  const file = UserHarnessesFile.safeParse(parseJson(path, text));
  if (!file.success) {
    throw refuse(
      path,
      `expected {"harnesses": [...]}: ${flattenIssues(file.error.issues).join("; ")}`,
    );
  }
  const seen = new Set<string>();
  return file.data.harnesses.map((entry, index) => {
    const where = `harnesses[${index}]${labelOf(entry)}`;
    const parsed = parseHarnessSpec(entry, UserHarnessSpecSchema);
    if (!parsed.ok) throw refuse(path, `${where}: ${parsed.issues.join("; ")}`);
    const id = parsed.spec.id;
    if (HARNESS_IDS.some((builtIn) => builtIn === id)) {
      throw refuse(path, `${where}: "${id}" is a built-in harness id`, {
        hint: "pick another id; built-in harnesses cannot be redefined",
      });
    }
    if (seen.has(id)) throw refuse(path, `${where}: "${id}" is declared twice`);
    seen.add(id);
    return { ...toDefinition(parsed.spec), userDefined: true };
  });
}

function labelOf(entry: unknown): string {
  if (typeof entry !== "object" || entry === null || !("id" in entry)) return "";
  const id = entry.id;
  return typeof id === "string" ? ` (id "${id}")` : "";
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    throw refuse(path, `cannot read: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function parseJson(path: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw refuse(path, `not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function refuse(path: string, reason: string, options: { hint?: string } = {}): MaximsError {
  return new MaximsError(ExitCode.DestinationWriteFailed, `${path}: ${reason}`, options);
}
