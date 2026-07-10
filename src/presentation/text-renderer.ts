import type { DoctorCheck, DoctorReport } from "../domain/doctor.ts";

export function renderDoctorText(report: DoctorReport): string {
  const lines = [
    "agentloop doctor",
    `repo: ${report.repoPath ?? report.repoInput}`,
    `state: ${report.stateDir}`,
  ];

  if (report.worktreeRoot !== null) {
    lines.push(`worktrees: ${report.worktreeRoot}`);
  }

  lines.push("");

  for (const check of report.checks) {
    lines.push(renderCheck(check));
  }

  return `${lines.join("\n")}\n`;
}

function renderCheck(check: DoctorCheck): string {
  const evidence =
    check.evidence.length === 0
      ? ""
      : `\n${check.evidence.map((item) => `    ${item}`).join("\n")}`;

  return `[${check.status.toUpperCase()}] ${check.name}: ${check.message}${evidence}`;
}
