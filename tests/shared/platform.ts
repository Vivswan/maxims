// Facts the suite skips or branches on: Windows has no POSIX mode bits, no exec bit, and no sh, and
// a 0000 file there and on the macOS runner stays readable, so refusals built on those never fire.
export const WINDOWS = process.platform === "win32";
export const MACOS = process.platform === "darwin";
