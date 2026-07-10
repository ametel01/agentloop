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

export class OpenRunConflictError extends AgentloopError {
  constructor(readonly existingRunId: string) {
    super(`An open run already exists for this repository: ${existingRunId}`, 75);
    this.name = "OpenRunConflictError";
  }
}

export class StateConflictError extends AgentloopError {
  constructor(message: string) {
    super(message, 70);
    this.name = "StateConflictError";
  }
}
