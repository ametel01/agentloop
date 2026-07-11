import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
  unlink,
} from "node:fs/promises";
import { delimiter, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface InstallOptions {
  readonly dryRun: boolean;
  readonly updateProfile: boolean;
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const markerStart = "# agentloop global bin: start";
const markerEnd = "# agentloop global bin: end";

const options = parseArgs(Bun.argv.slice(2));

if (options === "help") {
  printHelp();
  process.exit(0);
}

try {
  await installGlobal(options);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function installGlobal(options: InstallOptions): Promise<void> {
  const globalBin = await getGlobalBin(options);

  await run(["bun", "run", "build"], options);
  await run(["bun", "link"], options);
  await linkAgentloopBinary(globalBin, options);

  const profile = resolveProfile(process.env);
  const currentPathHasGlobalBin = pathIncludes(process.env.PATH ?? "", globalBin);

  if (!options.updateProfile) {
    printManualPathInstructions(globalBin, profile);
    printInstalled(currentPathHasGlobalBin, options);
    return;
  }

  if (profile === null) {
    printManualPathInstructions(globalBin, profile);
    printInstalled(currentPathHasGlobalBin, options);
    return;
  }

  const changed = await ensureProfilePath(profile, globalBin, process.env.HOME ?? "", options);

  if (changed) {
    const verb = options.dryRun ? "Would add" : "Added";
    console.log(`${verb} ${globalBin} to ${profile}.`);
  } else {
    console.log(`${globalBin} is already configured in ${profile}.`);
  }

  printInstalled(currentPathHasGlobalBin, options);
}

function parseArgs(args: readonly string[]): InstallOptions | "help" {
  let dryRun = false;
  let updateProfile = true;

  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--no-profile") {
      updateProfile = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return "help";
    }
    throw new Error(`Unsupported option: ${arg}`);
  }

  return { dryRun, updateProfile };
}

async function getGlobalBin(options: InstallOptions): Promise<string> {
  if (options.dryRun) {
    const fallback = process.env.HOME ? `${process.env.HOME}/.bun/bin` : "~/.bun/bin";
    console.log(`Would resolve Bun global bin with: bun pm bin -g`);
    return fallback;
  }

  const proc = Bun.spawn(["bun", "pm", "bin", "-g"], {
    cwd: repoRoot,
    stderr: "inherit",
    stdout: "pipe",
  });
  const output = (await new Response(proc.stdout).text()).trim();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}: bun pm bin -g`);
  }
  if (output.length === 0) {
    throw new Error("bun pm bin -g returned an empty path");
  }

  return output;
}

async function run(command: string[], options: InstallOptions): Promise<void> {
  if (options.dryRun) {
    console.log(`Would run: ${command.map(shellQuote).join(" ")}`);
    return;
  }

  const proc = Bun.spawn(command, {
    cwd: repoRoot,
    stderr: "inherit",
    stdout: "inherit",
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
  }
}

async function linkAgentloopBinary(globalBin: string, options: InstallOptions): Promise<void> {
  const target = `${repoRoot}dist/cli.js`;
  const linkPath = `${globalBin}/agentloop`;

  if (options.dryRun) {
    console.log(`Would link ${linkPath} -> ${target}`);
    return;
  }

  if (!existsSync(target)) {
    throw new Error(`Expected built CLI at ${target}`);
  }

  await mkdir(globalBin, { recursive: true, mode: 0o755 });
  await chmod(target, 0o755);
  await replaceSymlink(linkPath, target);
  await verifySymlink(linkPath, target);
}

async function replaceSymlink(linkPath: string, target: string): Promise<void> {
  try {
    const current = await lstat(linkPath);
    if (current.isSymbolicLink()) {
      const currentTarget = await readlink(linkPath);
      if (currentTarget === target) {
        return;
      }
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  await unlinkIfExists(linkPath);
  await symlink(target, linkPath);
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

async function verifySymlink(linkPath: string, target: string): Promise<void> {
  const stat = await lstat(linkPath);
  if (!stat.isSymbolicLink()) {
    throw new Error(`${linkPath} exists but is not a symlink`);
  }

  const actualTarget = await readlink(linkPath);
  if (actualTarget !== target) {
    throw new Error(`${linkPath} points to ${actualTarget}, expected ${target}`);
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function resolveProfile(env: NodeJS.ProcessEnv): string | null {
  const home = env.HOME;
  if (!home) {
    return null;
  }

  const shell = env.SHELL ?? "";
  if (shell.endsWith("/zsh") || shell === "zsh") {
    return `${home}/.zshrc`;
  }
  if (shell.endsWith("/bash") || shell === "bash") {
    return `${home}/.bashrc`;
  }

  return `${home}/.profile`;
}

async function ensureProfilePath(
  profile: string,
  globalBin: string,
  home: string,
  options: InstallOptions,
): Promise<boolean> {
  const existing = existsSync(profile) ? await readFile(profile, "utf8") : "";
  if (existing.includes(markerStart) || existing.includes(globalBin)) {
    return false;
  }

  const shellPath = toShellPath(globalBin, home);
  const block = `\n${markerStart}\nexport PATH="${shellPath}:$PATH"\n${markerEnd}\n`;

  if (options.dryRun) {
    console.log(`Would append to ${profile}:${block}`);
    return true;
  }

  await appendFile(profile, block, { mode: 0o600 });
  return true;
}

function toShellPath(path: string, home: string): string {
  if (home.length === 0) {
    return path.replaceAll('"', '\\"');
  }

  if (path === home) {
    return "$HOME";
  }

  const pathRelativeToHome = relative(home, path);
  if (!pathRelativeToHome.startsWith("..") && pathRelativeToHome !== "") {
    return `$HOME/${pathRelativeToHome.split(sep).join("/")}`;
  }

  return path.replaceAll('"', '\\"');
}

function pathIncludes(pathValue: string, target: string): boolean {
  return pathValue.split(delimiter).includes(target);
}

function printInstalled(currentPathHasGlobalBin: boolean, options: InstallOptions): void {
  if (options.dryRun) {
    console.log("agentloop would be rebuilt and linked globally.");
  } else {
    console.log("agentloop has been rebuilt and linked globally.");
  }

  if (!currentPathHasGlobalBin) {
    console.log("Open a new shell or source your shell profile before running `agentloop` here.");
  }
}

function printManualPathInstructions(globalBin: string, profile: string | null): void {
  const destination = profile ?? "your shell profile";
  const shellPath = toShellPath(globalBin, process.env.HOME ?? "");
  console.log(`Add this line to ${destination}:`);
  console.log(`export PATH="${shellPath}:$PATH"`);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function printHelp(): void {
  console.log(`Usage: bun run install:global [--dry-run] [--no-profile]

Rebuild agentloop, register this checkout with Bun, and link the agentloop binary globally.

Options:
  --dry-run     Print commands and profile changes without executing them.
  --no-profile  Do not update the shell profile; print PATH instructions instead.`);
}
