// Facts the suite skips or branches on: Windows has no POSIX mode bits, no exec bit, and no sh, so
// refusals and modes built on those never take effect there. Mode bits also do not stop root, so a
// chmod that must deny a read or a write only proves anything on a POSIX runner that is not root.
export const WINDOWS = process.platform === "win32";
export const CHMOD_DENIES = !WINDOWS && process.getuid?.() !== 0;
