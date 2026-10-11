import type { Console } from "../../console/contract.ts";
import { noTargetAtScope, notDefinedHere, STRINGS } from "../../console/strings.ts";
import type { HarnessId } from "../../contracts/harness-id.ts";
import { harnessContext } from "../../engine/context.ts";
import { sourceSlug } from "../../engine/slug.ts";
import type { HarnessDefinition } from "../../harnesses/contract.ts";
import { detectedHarnesses, scopeOf, targetPath, tildify } from "../frame/lookup.ts";
import { type CommandContext, usage } from "../frame/options.ts";
import type { AddRequest } from "./request.ts";

export type HarnessChoice = { ids: HarnessId[]; warnings: string[]; remember: boolean };

export async function chooseHarnesses(
  request: AddRequest,
  ctx: CommandContext,
  console: Console,
): Promise<HarnessChoice | null> {
  const { io, config } = ctx;
  const scope = scopeOf(request.destination);
  const hasTarget = (def: HarnessDefinition): boolean =>
    request.destination.scope === "out" || def.targets[scope] !== null;
  // An id this machine has no definition for (a user-declared harness from a manifest) stays in
  // intent, where sync notices and skips it, rather than being dropped from what was asked.
  const withTarget = (ids: readonly HarnessId[], warnings: string[]): HarnessId[] =>
    ids.filter((id) => {
      const def = io.harnesses.find((candidate) => candidate.id === id);
      if (def === undefined) {
        warnings.push(notDefinedHere(id));
        return true;
      }
      if (hasTarget(def)) return true;
      warnings.push(noTargetAtScope(id, scope));
      return false;
    });
  const warnings: string[] = [];
  if (request.agents.kind === "ids") {
    return { ids: withTarget(request.agents.ids, warnings), warnings, remember: false };
  }
  if (request.agents.kind === "all") {
    return { ids: io.harnesses.filter(hasTarget).map((def) => def.id), warnings, remember: false };
  }
  const detected = detectedHarnesses(io);
  if (detected.length > 0)
    return { ids: withTarget(detected, warnings), warnings, remember: false };
  if (config.agents !== undefined && config.agents.length > 0) {
    return { ids: withTarget(config.agents, warnings), warnings, remember: false };
  }
  const ctxHarness = harnessContext(io);
  const options = io.harnesses.filter(hasTarget).map((def) => ({
    value: def.id,
    label: def.displayName,
    hint: tildify(
      targetPath(def, request.destination, ctxHarness, sourceSlug(request.from)) ?? "",
      io.userHome,
    ),
  }));
  const remembered = config.lastAgents ?? [];
  const answer = await console.multiselect(STRINGS.whichAgents, options, remembered);
  if (answer.kind === "cancelled") return null;
  const chosen =
    answer.kind === "silent"
      ? remembered
      : answer.values.flatMap((id) => io.harnesses.filter((d) => d.id === id).map((d) => d.id));
  if (chosen.length === 0) {
    throw usage("no harness detected on this machine", { hint: "pass -a <id> (or -a '*')" });
  }
  return { ids: withTarget(chosen, warnings), warnings, remember: answer.kind === "chosen" };
}
