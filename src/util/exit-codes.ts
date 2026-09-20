// Codes 3, 6, 7 and 8 share one meaning: the install would be incomplete, so nothing is written.
/** @public */
export enum ExitCode {
  Ok = 0,
  Usage = 1,
  SourceUnresolvable = 2,
  NothingResolved = 3,
  DestinationWriteFailed = 4,
  StoreLocked = 5,
  NameCollision = 6,
  UnmetDependency = 7,
  RuleCapExceeded = 8,
}

export type MaximsErrorOptions = {
  hint?: string;
  cause?: unknown;
};

export class MaximsError extends Error {
  readonly code: ExitCode;
  readonly hint: string | undefined;

  constructor(code: ExitCode, message: string, options: MaximsErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MaximsError";
    this.code = code;
    this.hint = options.hint;
  }
}
