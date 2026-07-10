export class AgentloopError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "AgentloopError";
  }
}

export class CliUsageError extends AgentloopError {
  constructor(message: string) {
    super(message, 64);
    this.name = "CliUsageError";
  }
}
