import type { HarnessId } from "../harnesses/contract.ts";
import type { Plan } from "../util/change.ts";

export type CommonOptions = {
  quiet: boolean;
  dryRun: boolean;
  json: boolean;
};

export type SyncOptions = CommonOptions & {
  noFetch: boolean;
  agents?: HarnessId[];
  force: boolean;
};

export type SyncReport = {
  sources: number;
  rules: number;
  fetched: string[];
  changed: string[];
  notices: string[];
  plan: Plan;
};
