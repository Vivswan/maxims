// The rule-file staleness line, recognized by the phrase every rendering carries, so a test can
// count the lines a run added and compare the rest of the file byte for byte.
export const STALE_LINE = "have not refreshed since";

export function staleLines(text: string): string[] {
  return text.split("\n").filter((line) => line.includes(STALE_LINE));
}

export function withoutStaleLine(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.includes(STALE_LINE))
    .join("\n");
}
