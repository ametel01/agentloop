export type DoctorCheckStatus = "pass" | "warning" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  message: string;
  evidence: string[];
}

export interface SkillManifestEntry {
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAtMs: number;
  sha256: string;
}

export interface DoctorReport {
  repoInput: string;
  repoPath: string | null;
  stateDir: string;
  worktreeRoot: string | null;
  skillManifestHash: string | null;
  skillManifest: SkillManifestEntry[];
  checks: DoctorCheck[];
}

export function reportHasFailures(report: DoctorReport): boolean {
  return report.checks.some((check) => check.status === "fail");
}
