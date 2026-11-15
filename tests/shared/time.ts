export const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns the ISO timestamp `days` days before `now`. */
export function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}
