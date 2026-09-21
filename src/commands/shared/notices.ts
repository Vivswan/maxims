// The one channel every engine message goes through, so the surfaces cannot disagree about what
// was said: `user` reaches stdout on an interactive run, `quietStdout` is the subset a hook
// invocation may print in its harness's protocol, `stderr` is what an interactive run says about
// a failure that earns no stdout line yet, and `log` is appended to log/refresh.log.
export class Notices {
  readonly user: string[] = [];
  readonly quietStdout: string[] = [];
  readonly stderr: string[] = [];
  readonly log: string[] = [];

  notice(line: string): void {
    this.user.push(line);
    this.log.push(line);
  }

  // The staleness and write-failure lines: a session should hear them even from a hook.
  loud(line: string): void {
    this.user.push(line);
    this.quietStdout.push(line);
    this.log.push(line);
  }

  trace(line: string): void {
    this.log.push(line);
  }

  // A failure the run exits non-zero for: an interactive run must not exit 2 in silence, while a
  // hook run keeps it out of the session and in the log.
  aside(line: string): void {
    this.stderr.push(line);
    this.log.push(line);
  }

  absorb(other: Notices): void {
    this.user.push(...other.user);
    this.quietStdout.push(...other.quietStdout);
    this.stderr.push(...other.stderr);
    this.log.push(...other.log);
  }
}
