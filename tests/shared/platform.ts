// Facts the suite skips or branches on: Windows has no POSIX mode bits, no exec bit, and no sh, so
// refusals and modes built on those never take effect there.
export const WINDOWS = process.platform === "win32";
