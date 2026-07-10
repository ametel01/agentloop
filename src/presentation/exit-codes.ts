import { reportHasFailures, type DoctorReport } from "../domain/doctor.ts";

export const EXIT_CODES = {
  ok: 0,
  usage: 64,
  internal: 70,
} as const;

export function doctorExitCode(report: DoctorReport): number {
  return reportHasFailures(report) ? EXIT_CODES.usage : EXIT_CODES.ok;
}
