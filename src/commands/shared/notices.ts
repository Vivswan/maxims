// The one channel every engine message goes through, so the three surfaces cannot disagree about
// what was said: `user` reaches stdout on an interactive run, `quietStdout` is the subset a hook
// invocation may print in its harness's protocol, and `log` is appended to log/refresh.log.
export class Notices {
  readonly user: string[] = [];
  readonly quietStdout: string[] = [];
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

  absorb(other: Notices): void {
    this.user.push(...other.user);
    this.quietStdout.push(...other.quietStdout);
    this.log.push(...other.log);
  }
}
