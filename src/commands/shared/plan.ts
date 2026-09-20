import type { Change, Plan } from "../../util/change.ts";

// `store` swaps a fetched entry, `destination` writes bodies and rule files, `removal` takes back
// artifacts an intent no longer derives, `orphan` sweeps store entries nothing derives, `hook`
// reconciles registries and config edits, `state` writes state.json. A hook run may not take
// anything away: a partial read must never empty a machine, so the two categories that only
// remove are held back whole, and a deletion in any other category except the store swap (whose
// delete is half of a fetch) waits for the next interactive run.
export type ChangeCategory = "store" | "destination" | "removal" | "orphan" | "hook" | "state";

// `owner` names the source a change lands for, so a source refused after its changes were planned
// (a byte budget is only known once the file is rendered) can have them taken back.
export type PlannedChange = { category: ChangeCategory; change: Change; owner: string | null };

export type BuiltPlan = {
  plan: Plan;
  deferred: Change[];
};

const REMOVING: ReadonlySet<ChangeCategory> = new Set(["removal", "orphan"]);

export class PlanBuilder {
  private readonly planned: PlannedChange[] = [];

  add(category: ChangeCategory, changes: readonly Change[], owner: string | null = null): void {
    for (const change of changes) this.planned.push({ category, change, owner });
  }

  drop(owner: string): void {
    for (let index = this.planned.length - 1; index >= 0; index -= 1) {
      if (this.planned[index]?.owner === owner) this.planned.splice(index, 1);
    }
  }

  build(options: { deferDeletions: boolean; notices: readonly string[] }): BuiltPlan {
    const changes: Change[] = [];
    const deferred: Change[] = [];
    for (const { category, change } of this.planned) {
      const deletes = change.kind === "delete" || change.kind === "unlink";
      const takesAway = REMOVING.has(category) || (deletes && category !== "store");
      if (options.deferDeletions && takesAway) deferred.push(change);
      else changes.push(change);
    }
    return { plan: { changes, notices: [...options.notices] }, deferred };
  }
}
