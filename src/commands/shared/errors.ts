import { MaximsError } from "../../util/exit-codes.ts";

// A failure the run has already printed (as the `--json` document or the interactive lines), so
// the caller maps it to an exit code without printing it a second time. It lives apart from the
// report module so the command line can recognize it without drawing the planner in.
export class ReportedMaximsError extends MaximsError {}
