// The one order of names, paths and source keys wherever a file or a list must come out the same
// on two machines (block order in a shared file, the tie-break of installation order, the
// self-refresh line's owner, a tree hash): by code unit, ascending. Neither history nor locale
// enters.
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
