import type { CommandOptions, CommandResult, CommandRunner } from "../application/ports.ts";

export class ProductionCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    const controller = new AbortController();
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const spawnOptions = {
        stderr: "pipe",
        stdout: "pipe",
        stdin: "ignore",
        signal: controller.signal,
      } as const;
      const process =
        options.cwd === undefined
          ? Bun.spawn([command, ...args], spawnOptions)
          : Bun.spawn([command, ...args], { ...spawnOptions, cwd: options.cwd });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);

      return { exitCode, stdout, stderr };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return { exitCode: 124, stdout: "", stderr: "Command timed out" };
      }

      const message = error instanceof Error ? error.message : String(error);
      return { exitCode: 127, stdout: "", stderr: message };
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }
}
