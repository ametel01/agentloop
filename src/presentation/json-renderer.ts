import type { DoctorReport } from "../domain/doctor.ts";

export function renderDoctorJson(report: DoctorReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
