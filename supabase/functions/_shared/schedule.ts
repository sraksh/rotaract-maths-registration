/**
 * Examination schedule — the single source of truth for class/shift/timing.
 *
 * At runtime the authoritative schedule lives in the `exam_schedules` table
 * (so authorised admins can adjust it) and is delivered to the form through
 * `get_public_config()`. The form labels, confirmation screen, reports and
 * exports ALL derive their text from `scheduleLabel()` / `formatTime12()`
 * below, so they cannot drift apart.
 *
 * DEFAULT_SCHEDULES is the initial data seeded by the migrations. A test
 * asserts that the SQL seed and this constant are identical.
 */

export type ClassLevel = 7 | 8 | 9 | 10;
export type ShiftNumber = 1 | 2;

export interface ExamSchedule {
  classLevel: ClassLevel;
  shift: ShiftNumber;
  /** 24-hour "HH:MM" */
  examStart: string;
  /** 24-hour "HH:MM" */
  examEnd: string;
  /** 24-hour "HH:MM" */
  reportingTime: string;
}

export const CLASS_LEVELS: readonly ClassLevel[] = [7, 8, 9, 10];

export const DEFAULT_SCHEDULES: readonly ExamSchedule[] = [
  { classLevel: 7, shift: 1, examStart: '10:00', examEnd: '12:00', reportingTime: '09:30' },
  { classLevel: 8, shift: 2, examStart: '13:30', examEnd: '15:30', reportingTime: '13:00' },
  { classLevel: 9, shift: 1, examStart: '10:00', examEnd: '12:00', reportingTime: '09:30' },
  { classLevel: 10, shift: 2, examStart: '13:30', examEnd: '15:30', reportingTime: '13:00' },
];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isHHMM(value: unknown): value is string {
  return typeof value === 'string' && HHMM.test(value);
}

/** "13:30" -> "1:30 PM", "09:30" -> "9:30 AM", "12:00" -> "12:00 PM" */
export function formatTime12(hhmm: string): string {
  const m = HHMM.exec(hhmm);
  if (!m) throw new Error(`Invalid time: ${hhmm}`);
  const hour24 = Number(m[1]);
  const minutes = m[2];
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${minutes} ${suffix}`;
}

/** "10:00 AM–12:00 PM" (en dash) */
export function formatExamWindow(s: Pick<ExamSchedule, 'examStart' | 'examEnd'>): string {
  return `${formatTime12(s.examStart)}–${formatTime12(s.examEnd)}`;
}

/**
 * The exact option text required by the specification, e.g.
 * "Class 7 — Shift 1 (Classes 7th): 10:00 AM–12:00 PM (Reporting: 9:30 AM)"
 */
export function scheduleLabel(s: ExamSchedule): string {
  return (
    `Class ${s.classLevel} — Shift ${s.shift} (Classes ${s.classLevel}th): ` +
    `${formatExamWindow(s)} (Reporting: ${formatTime12(s.reportingTime)})`
  );
}

export function findSchedule(
  schedules: readonly ExamSchedule[],
  classLevel: number,
): ExamSchedule | undefined {
  return schedules.find((s) => s.classLevel === classLevel);
}

/** Returns a list of human-readable problems; empty when the schedule set is valid. */
export function validateSchedules(schedules: readonly ExamSchedule[]): string[] {
  const problems: string[] = [];
  for (const level of CLASS_LEVELS) {
    const matches = schedules.filter((s) => s.classLevel === level);
    if (matches.length !== 1) problems.push(`Class ${level} must have exactly one schedule.`);
  }
  for (const s of schedules) {
    if (!CLASS_LEVELS.includes(s.classLevel)) problems.push(`Unsupported class ${String(s.classLevel)}.`);
    if (s.shift !== 1 && s.shift !== 2) problems.push(`Class ${s.classLevel}: shift must be 1 or 2.`);
    if (!isHHMM(s.examStart) || !isHHMM(s.examEnd) || !isHHMM(s.reportingTime)) {
      problems.push(`Class ${s.classLevel}: times must be in HH:MM format.`);
      continue;
    }
    if (s.examStart >= s.examEnd) problems.push(`Class ${s.classLevel}: exam must end after it starts.`);
    if (s.reportingTime > s.examStart) {
      problems.push(`Class ${s.classLevel}: reporting time must not be after the exam start.`);
    }
  }
  return problems;
}
