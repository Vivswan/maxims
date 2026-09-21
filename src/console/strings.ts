// The strings of the frame and the messages shared by more than one verb, so the plain and the
// clack renderers cannot drift from each other and the golden fixtures pin one table. Wording
// follows `npx skills` where a concept is shared; see the parity table in the CLI reference.

export function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function memories(n: number): string {
  return count(n, "memory", "memories");
}

export function ruleLines(n: number): string {
  return count(n, "rule line", "rule lines");
}

export function sources(n: number): string {
  return count(n, "source", "sources");
}

export const STRINGS = {
  agentDetected: "Agent detected - installing non-interactively",
  cloning: "Cloning repository...",
  cloned: "Repository cloned",
  cloneFailed: "Failed to clone repository",
  directoryUnreadable: "Failed to read directory",
  cancelled: "Cancelled",
  expectedMemoryName: "expected a kebab-case memory name",
  readingDirectory: "Reading directory...",
  directoryRead: "Directory read",
  memoriesToInstall: "Memories to install",
  availableMemories: "Available Memories",
  proceed: "Proceed with installation?",
  installationCancelled: "Installation cancelled",
  removalCancelled: "Removal cancelled",
  runWithoutList: "Run without --list to install",
  whichAgents: "Which agents do you want to install to?",
  checkingUpdates: "Checking for memory updates...",
  allUpToDate: "All memories are up to date",
  missingSource: "Missing required argument: source",
  runHelp: "Run maxims --help for usage.",
  jsonNeedsYes: "The --json flag requires --yes (or --all) to run non-interactively.",
  jsonWithList: "The --json flag cannot be combined with --list.",
  allWithNames: "Cannot combine --all with specific memory names.",
  twoDestinations: "two destinations given",
  removeNeedsTty:
    "Interactive prompt required but stdin is not a TTY. Nothing was removed. Use -y to run non-interactively.",
  storeEmpty: "Found 0 memories (store empty; run without --no-fetch)",
  noManifest: "no manifest",
  nothingHeld: "nothing held for review",
  allWithSource: "--all accepts every held source; drop the source name",
} as const;

export function found(n: number, internalHidden: number): string {
  const hidden = internalHidden > 0 ? ` (${internalHidden} internal, hidden)` : "";
  return `Found ${memories(n)}${hidden}`;
}

export function selected(names: readonly string[]): string {
  return `Selected ${memories(names.length)}: ${names.join(", ")}`;
}

export function installed(memoryCount: number, ruleCount: number, tokens: number): string {
  return `Installed ${memories(memoryCount)}, ${ruleLines(ruleCount)} (~${tokens} tokens)`;
}

export function hookRegistered(command: string): string {
  return `Hook registered: SessionStart -> ${command}`;
}

export function unknownCommand(verb: string): string {
  return `Unknown command: ${verb}`;
}

export function invalidAgents(
  ids: readonly string[],
  valid: readonly string[],
  closest: string | null,
) {
  const lines = [`Invalid agents: ${ids.join(", ")}`, `Valid agents: ${valid.join(", ")}`];
  if (closest !== null) lines.push(`did you mean ${closest}?`);
  return lines.join("\n");
}

export function moreItems(n: number): string {
  return `... ${n} more`;
}

export function alreadyInstalled(name: string, owner: string): string {
  return `${name} is already installed from ${owner}; rename the incoming memory?`;
}

export function ownedBy(name: string, owner: string): string {
  return `${name} is owned by ${owner}`;
}

export function renameHint(name: string): string {
  return `--rename ${name}=<new>`;
}

export function linksTo(memory: string, target: string): string {
  return `${memory} links to [[${target}]], which is not installed`;
}

export function notDefinedHere(harness: string): string {
  return `${harness} is not defined on this machine; kept in intent, skipped until it is`;
}

export function noTargetAtScope(harness: string, scope: string): string {
  return `${harness} has no ${scope} target; skipped`;
}

export function notAMemory(file: string, reason: string): string {
  return `${file} is not a memory: ${reason}`;
}

export function privacyWarning(repo: string): string {
  return `installing a local source into the project at ${repo}: its text lands in files that repository may commit`;
}

export function replacedSelection(previous: string, next: string): string {
  return `Selection replaced: ${previous} -> ${next}`;
}

export function isLive(path: string): string {
  return `${path} is live; nothing to fetch`;
}

export function foundUpdates(n: number): string {
  return `Found ${n} update(s)`;
}

export function updated(key: string, added: number, removed: number): string {
  return `Updated ${key} (+${added} -${removed} rule)`;
}

export function changedLines(n: number): string {
  return count(n, "changed line", "changed lines");
}

// The one line a hold prints, from the engine (a session hears it from the hook) and from `update`.
export function heldForReview(key: string, changed: number): string {
  return `maxims: ${key} has ${changedLines(changed)} held for review; run maxims accept ${key}`;
}

export function heldUpdate(key: string, changed: number): string {
  return `Held ${key} (${changedLines(changed)}); run maxims accept ${key}`;
}

// The `list` token beside a source with a revision waiting; a reviewed source with none says `review`.
export function heldToken(key: string, changed: number): string {
  return `held (${changedLines(changed)}; run maxims accept ${key})`;
}

export function heldFinding(key: string, changed: number): string {
  return `${key}: ${changedLines(changed)} held for review (run maxims accept ${key})`;
}

export function reviewing(key: string): string {
  return `Reviewing ${key}; upstream changes wait for maxims accept`;
}

export function alreadyReviewing(key: string): string {
  return `${key} is already marked for review`;
}

export function notReviewing(key: string): string {
  return `${key} was not marked for review`;
}

export function unreviewed(key: string): string {
  return `Unreviewed ${key}; upstream changes apply at once`;
}

export function accepted(key: string, changed: number): string {
  return `Accepted ${key} (${changedLines(changed)})`;
}

export function nothingHeld(key: string): string {
  return `${key} has nothing held for review`;
}

export function heldRevisionGone(key: string): string {
  return `the held revision of ${key} is gone; run maxims update to fetch it again`;
}

export function heldRevisionAltered(key: string): string {
  return `the held revision of ${key} no longer matches what was fetched; run maxims update to fetch it again`;
}

export function failedToUpdate(key: string, reason: string): string {
  return `Failed to update ${key}: ${reason}`;
}

export function foundInManifest(n: number, path: string): string {
  return `Found ${sources(n)} in ${path}`;
}

export function wasNotDisabled(name: string, scope: string): string {
  return `${name} was not disabled at ${scope}`;
}

export function hiddenCharacter(memory: string, label: string, column: number): string {
  return `${memory}: ${label} at column ${column}`;
}

export function firstSourceFrom(owner: string): string {
  return `First source from ${owner}`;
}

export function riskWarning(memory: string, kind: string, detail: string, column: number): string {
  return `${memory}: ${kind}: ${detail} at column ${column}`;
}
