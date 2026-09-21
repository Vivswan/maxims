import { isAbsolute, relative, sep } from "node:path";
import type { Console } from "../../console/contract.ts";
import { riskWarning } from "../../console/strings.ts";
import type { Memory, MemoryName } from "../../memory/contract.ts";
import { type RiskKind, riskWarnings } from "../../memory/risk.ts";
import type { TreeFile, TreeScope } from "../../sources/tree.ts";
import type { State } from "../../state/schema.ts";
import type { Plan } from "../../util/change.ts";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import { storePathFor } from "../../util/home.ts";
import type { CliIo } from "../types.ts";
import { actsHere } from "./context.ts";
import { readSourceMemories, type SourceMemory, validateMemoryFiles } from "./memories.ts";
import { disabledNames, selectMemories } from "./select.ts";

// A risky shape in a description, named for the memory that carries it. The column is 1-based, as
// the printed line and the hidden-character refusal count it, where the detector's is an offset.
export type MemoryRiskWarning = {
  memory: MemoryName;
  kind: RiskKind;
  detail: string;
  column: number;
};

export function riskWarningsFor(
  memories: readonly Pick<Memory, "name" | "description">[],
): MemoryRiskWarning[] {
  return memories.flatMap((memory) =>
    riskWarnings(memory.description).map((warning) => ({
      memory: memory.name,
      kind: warning.kind,
      detail: warning.detail,
      column: warning.column + 1,
    })),
  );
}

export function riskLine(warning: MemoryRiskWarning): string {
  return riskWarning(warning.memory, warning.kind, warning.detail, warning.column);
}

export function showRiskWarnings(console: Console, warnings: readonly MemoryRiskWarning[]): void {
  for (const warning of warnings) console.warn(riskLine(warning));
}

// The `--strict` refusal: the same exit as a hidden character, since both are a description the
// review gate should not pass unseen.
export function refuseRisky(warnings: readonly MemoryRiskWarning[]): void {
  const [first, ...rest] = warnings;
  if (first === undefined) return;
  const more = rest.length === 0 ? "" : ` (and ${rest.length} more)`;
  throw new MaximsError(ExitCode.NothingResolved, `${riskLine(first)}${more}`, {
    hint: "drop --strict to install anyway",
  });
}

// The descriptions an `update` installs, judged as the sync installs them. A refreshed source
// that is unchanged upstream writes nothing to the store, yet a rename typed beside `--strict`
// can lift a disabled memory into the rule file, so its store copy is read where the plan has no
// write for it. A directory that cannot be read yields no warning here; the sync reports that
// failure as the source's own.
export async function refreshWarnings(
  plan: Plan,
  state: State,
  io: Pick<CliIo, "home" | "env" | "projectRoot">,
  only: readonly string[] | undefined,
): Promise<MemoryRiskWarning[]> {
  const warnings: MemoryRiskWarning[] = [];
  const installInternal = io.env.MAXIMS_INSTALL_INTERNAL === "1";
  for (const [key, entry] of Object.entries(state.sources)) {
    if (!actsHere(entry, io)) continue;
    const { from, destination } = entry.intent;
    const memories =
      from.type === "local" && from.live === true
        ? await memoriesAt(from.path, entry.intent)
        : await fetchedMemories(plan, storePathFor(io.home, from), entry.intent, only, key);
    const { selected } = selectMemories({
      memories,
      intent: entry.intent,
      installInternal,
      disabled: disabledNames(state, destination.scope, io.projectRoot),
      detailPath: () => "",
    });
    warnings.push(...riskWarningsFor(selected.map(({ memory }) => memory.memory)));
  }
  return warnings;
}

async function fetchedMemories(
  plan: Plan,
  store: string,
  scope: TreeScope,
  only: readonly string[] | undefined,
  key: string,
): Promise<SourceMemory[]> {
  const writes = storeWrites(plan, store);
  if (writes.length > 0) return validateMemoryFiles(writes).memories;
  const refreshed = only === undefined || only.includes(key);
  return refreshed ? await memoriesAt(store, scope) : [];
}

async function memoriesAt(root: string, scope: TreeScope): Promise<SourceMemory[]> {
  try {
    return (await readSourceMemories(root, scope, () => undefined)).memories;
  } catch {
    return [];
  }
}

function storeWrites(plan: Plan, entry: string): TreeFile[] {
  return plan.changes.flatMap((change) => {
    if (change.kind !== "write" || !change.path.endsWith(".md") || !isInside(entry, change.path)) {
      return [];
    }
    return [{ relPath: relative(entry, change.path).split(sep).join("/"), text: change.content }];
  });
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
