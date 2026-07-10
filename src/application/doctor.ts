import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

import type { CommandRunner, FileSystem } from "./ports.ts";
import type { DoctorCheck, DoctorReport, SkillManifestEntry } from "../domain/doctor.ts";

const COMMAND_TIMEOUT_MS = 10_000;

export const REQUIRED_SKILLS = [
  "codex-dev-team-goal",
  "team-coordinator",
  "agent-team-status-protocol",
  "issue-spec-agent",
  "builder-agent",
  "checker-agent",
  "maintainer-reviewer",
  "process-retrospective-agent",
] as const;

export interface DoctorDependencies {
  commandRunner: CommandRunner;
  fileSystem: FileSystem;
  homeDir?: string;
  cwd?: string;
}

export interface DoctorOptions {
  repo: string;
}

export async function runDoctor(
  options: DoctorOptions,
  dependencies: DoctorDependencies,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const home = dependencies.homeDir ?? homedir();
  const cwd = dependencies.cwd ?? process.cwd();
  const repoInput = options.repo;
  const repoCandidate = resolve(cwd, repoInput);
  const stateDir = resolveStateDir(home, process.env);
  let repoPath: string | null = null;
  let worktreeRoot: string | null = null;
  let skillManifestHash: string | null = null;
  let skillManifest: SkillManifestEntry[] = [];

  const gitRoot = await dependencies.commandRunner.run(
    "git",
    ["-C", repoCandidate, "rev-parse", "--show-toplevel"],
    { timeoutMs: COMMAND_TIMEOUT_MS },
  );

  if (gitRoot.exitCode === 0 && gitRoot.stdout.trim() !== "") {
    repoPath = await safeRealpath(dependencies.fileSystem, gitRoot.stdout.trim());
    checks.push({
      name: "git-root",
      status: "pass",
      message: "Repository root resolved.",
      evidence: [repoPath],
    });
  } else {
    checks.push({
      name: "git-root",
      status: "fail",
      message: "Unable to resolve a Git repository root for --repo.",
      evidence: compactEvidence(gitRoot.stderr, gitRoot.stdout),
    });
  }

  if (repoPath !== null) {
    const repoName = repoPath.split("/").at(-1) ?? "repo";
    worktreeRoot = resolve(dirname(repoPath), ".agentloop-worktrees", repoName);
  }

  checks.push(await commandVersionCheck("codex-version", "codex", ["--version"], dependencies));
  checks.push(await codexSdkImportCheck());
  checks.push(await commandVersionCheck("gh-version", "gh", ["--version"], dependencies));
  checks.push(await ghAuthCheck(dependencies));
  checks.push(await ensureDirectoryCheck("state-dir", stateDir, dependencies.fileSystem, 0o700));

  if (worktreeRoot === null) {
    checks.push({
      name: "worktree-root",
      status: "fail",
      message: "Worktree root cannot be checked until the Git root resolves.",
      evidence: [],
    });
  } else {
    checks.push(
      await ensureDirectoryCheck("worktree-root", worktreeRoot, dependencies.fileSystem, 0o700),
    );
  }

  const skillResolution = await resolveRequiredSkills(home, dependencies.fileSystem);
  checks.push(...skillResolution.checks);
  skillManifest = skillResolution.manifest;
  skillManifestHash =
    skillManifest.length === REQUIRED_SKILLS.length + 1 ? hashSkillManifest(skillManifest) : null;

  if (skillManifestHash !== null) {
    checks.push({
      name: "skill-fingerprint",
      status: "pass",
      message: "Required skill manifest fingerprint computed.",
      evidence: [skillManifestHash],
    });
  } else {
    checks.push({
      name: "skill-fingerprint",
      status: "fail",
      message:
        "Required skill manifest fingerprint is unavailable because skill resolution failed.",
      evidence: [],
    });
  }

  if (repoPath !== null) {
    checks.push(...(await repoSurfaceChecks(repoPath, dependencies.fileSystem)));
  }

  checks.push({
    name: "trust-required",
    status: "warning",
    message: "Codex execution will require --trust-repo; doctor performs no model execution.",
    evidence: ["Repository instructions and code are untrusted inputs until explicitly accepted."],
  });

  return {
    repoInput,
    repoPath,
    stateDir,
    worktreeRoot,
    skillManifestHash,
    skillManifest,
    checks,
  };
}

function resolveStateDir(home: string, env: NodeJS.ProcessEnv): string {
  if (env.AGENTLOOP_STATE_DIR !== undefined && env.AGENTLOOP_STATE_DIR !== "") {
    return resolve(env.AGENTLOOP_STATE_DIR);
  }

  if (env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== "") {
    return resolve(env.XDG_STATE_HOME, "agentloop");
  }

  return resolve(home, ".local", "state", "agentloop");
}

async function safeRealpath(fileSystem: FileSystem, path: string): Promise<string> {
  try {
    return await fileSystem.realpath(path);
  } catch {
    return path;
  }
}

async function commandVersionCheck(
  name: string,
  command: string,
  args: readonly string[],
  dependencies: DoctorDependencies,
): Promise<DoctorCheck> {
  const result = await dependencies.commandRunner.run(command, args, {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });

  if (result.exitCode === 0) {
    return {
      name,
      status: "pass",
      message: `${command} is available.`,
      evidence: firstLines(result.stdout, 2),
    };
  }

  return {
    name,
    status: "fail",
    message: `${command} is unavailable or failed.`,
    evidence: compactEvidence(result.stderr, result.stdout),
  };
}

async function codexSdkImportCheck(): Promise<DoctorCheck> {
  try {
    await import("@openai/codex-sdk");
    return {
      name: "codex-sdk-import",
      status: "pass",
      message: "@openai/codex-sdk imports under Bun.",
      evidence: ["@openai/codex-sdk@0.144.1"],
    };
  } catch (error) {
    return {
      name: "codex-sdk-import",
      status: "fail",
      message: "@openai/codex-sdk could not be imported.",
      evidence: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function ghAuthCheck(dependencies: DoctorDependencies): Promise<DoctorCheck> {
  const result = await dependencies.commandRunner.run("gh", ["auth", "status"], {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });

  if (result.exitCode === 0) {
    return {
      name: "gh-auth",
      status: "pass",
      message: "GitHub CLI authentication is available.",
      evidence: sanitizeAuthEvidence(result.stdout, result.stderr),
    };
  }

  return {
    name: "gh-auth",
    status: "fail",
    message: "GitHub CLI authentication failed.",
    evidence: sanitizeAuthEvidence(result.stdout, result.stderr),
  };
}

async function ensureDirectoryCheck(
  name: string,
  path: string,
  fileSystem: FileSystem,
  mode: number,
): Promise<DoctorCheck> {
  try {
    await fileSystem.mkdir(path, { recursive: true, mode });
    const stat = await fileSystem.stat(path);

    if (!stat.isDirectory) {
      return {
        name,
        status: "fail",
        message: "Path exists but is not a directory.",
        evidence: [path],
      };
    }

    return {
      name,
      status: "pass",
      message: "Directory is available.",
      evidence: [path],
    };
  } catch (error) {
    return {
      name,
      status: "fail",
      message: "Directory is not writable or could not be created.",
      evidence: [path, error instanceof Error ? error.message : String(error)],
    };
  }
}

async function resolveRequiredSkills(
  home: string,
  fileSystem: FileSystem,
): Promise<{ checks: DoctorCheck[]; manifest: SkillManifestEntry[] }> {
  const manifest: SkillManifestEntry[] = [];
  const checks: DoctorCheck[] = [];

  for (const skillName of REQUIRED_SKILLS) {
    const skillPath = resolve(home, ".agents", "skills", skillName, "SKILL.md");
    const entry = await readSkillManifestEntry(skillName, skillPath, fileSystem);

    if (entry === null) {
      checks.push({
        name: `skill:${skillName}`,
        status: "fail",
        message: "Required skill file is missing or unreadable.",
        evidence: [skillPath],
      });
    } else {
      manifest.push(entry);
      checks.push({
        name: `skill:${skillName}`,
        status: "pass",
        message: "Required skill file is available.",
        evidence: [skillPath, entry.sha256],
      });
    }
  }

  const promptReferencePath = resolve(
    home,
    ".agents",
    "skills",
    "codex-dev-team-goal",
    "references",
    "sub-agent-prompts.md",
  );
  const promptReference = await readSkillManifestEntry(
    "codex-dev-team-goal/references/sub-agent-prompts.md",
    promptReferencePath,
    fileSystem,
  );

  if (promptReference === null) {
    checks.push({
      name: "skill-reference:sub-agent-prompts",
      status: "fail",
      message: "Required codex-dev-team-goal prompt reference is missing or unreadable.",
      evidence: [promptReferencePath],
    });
  } else {
    manifest.push(promptReference);
    checks.push({
      name: "skill-reference:sub-agent-prompts",
      status: "pass",
      message: "Required codex-dev-team-goal prompt reference is available.",
      evidence: [promptReferencePath, promptReference.sha256],
    });
  }

  return { checks, manifest };
}

async function readSkillManifestEntry(
  name: string,
  path: string,
  fileSystem: FileSystem,
): Promise<SkillManifestEntry | null> {
  try {
    const [stat, content] = await Promise.all([fileSystem.stat(path), fileSystem.readFile(path)]);

    if (!stat.isFile) {
      return null;
    }

    return {
      name,
      path,
      sizeBytes: stat.size,
      modifiedAtMs: stat.mtimeMs,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  } catch {
    return null;
  }
}

function hashSkillManifest(manifest: readonly SkillManifestEntry[]): string {
  const normalized = manifest
    .map((entry) => ({
      modifiedAtMs: entry.modifiedAtMs,
      name: entry.name,
      path: entry.path,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function repoSurfaceChecks(repoPath: string, fileSystem: FileSystem): Promise<DoctorCheck[]> {
  const surfaces = [
    "AGENTS.md",
    ".codex/config.toml",
    ".codex/mcp.json",
    ".mcp.json",
    "package.json",
    "bunfig.toml",
    ".github/workflows",
  ];

  const checks: DoctorCheck[] = [];

  for (const surface of surfaces) {
    const path = join(repoPath, surface);
    if (await fileSystem.access(path)) {
      checks.push({
        name: `repo-surface:${surface}`,
        status: "warning",
        message: "Repository-local instruction, configuration, or executable surface detected.",
        evidence: [path],
      });
    }
  }

  if (checks.length === 0) {
    checks.push({
      name: "repo-surfaces",
      status: "pass",
      message: "No repository-local instruction or tool configuration surfaces detected.",
      evidence: [],
    });
  }

  return checks;
}

function compactEvidence(...values: readonly string[]): string[] {
  return values
    .flatMap((value) => firstLines(value, 3))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function firstLines(value: string, count: number): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, count);
}

function sanitizeAuthEvidence(...values: readonly string[]): string[] {
  return compactEvidence(...values).map((line) =>
    line
      .replace(/gh[opsu]_[A-Za-z0-9_]+/g, "[redacted-token]")
      .replace(/github_pat_[A-Za-z0-9_]+/g, "[redacted-token]")
      .replace(/Token: .+/g, "Token: [redacted]"),
  );
}
