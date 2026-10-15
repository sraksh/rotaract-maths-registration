/**
 * Registration validation, used identically by the browser (for fast feedback)
 * and by the Edge Function (the real security control).
 *
 * The function accepts `unknown` input because the backend receives arbitrary
 * JSON from the network.
 */
import { findSchedule, type ExamSchedule } from './schedule.ts';

export type FieldName =
  | 'fullName'
  | 'schoolName'
  | 'rollNumber'
  | 'mobile'
  | 'classShift'
  | 'paymentScreenshot'
  | 'declaration';

export type FieldErrors = Partial<Record<FieldName, string>>;

export interface RegistrationInput {
  fullName: unknown;
  schoolName: unknown;
  rollNumber: unknown;
  mobile: unknown;
  classLevel: unknown;
  shift: unknown;
  declaration: unknown;
}

export interface NormalizedRegistration {
  fullName: string;
  schoolName: string;
  rollNumber: string;
  /** E.164 style, always "+91" followed by 10 digits. */
  mobile: string;
  classLevel: number;
  shift: number;
}

export interface ValidationContext {
  /** Approved school list; when empty, free text is accepted. */
  approvedSchools: readonly string[];
  schedules: readonly ExamSchedule[];
}

export type ValidationResult =
  | { ok: true; value: NormalizedRegistration }
  | { ok: false; errors: FieldErrors };

/** Same pattern as the CHECK constraint on event_config.upi_id. */
export const UPI_ID_RE = /^[A-Za-z0-9._-]{2,100}@[A-Za-z][A-Za-z0-9]{1,63}$/;

export const DECLARATION_TEXT =
  'I confirm that the information provided above is correct and that the uploaded payment screenshot relates to this registration.';

/** Collapses runs of whitespace to a single space and trims the ends. */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/gu, ' ').trim();
}

/** Comparison key used for matching schools: case-insensitive, whitespace-collapsed. */
export function schoolKey(s: string): string {
  return collapseWhitespace(s).toLowerCase();
}

/**
 * Normalises an Indian mobile number to "+91XXXXXXXXXX".
 * Accepts 10 digits starting 6-9, optionally prefixed by +91, 91, 0091 or 0,
 * with spaces, dashes, dots or brackets as separators. Returns null if invalid.
 */
export function normalizeIndianMobile(raw: string): string | null {
  let s = raw.replace(/[\s\-().]/gu, '');
  if (s.startsWith('+')) {
    if (!s.startsWith('+91')) return null;
    s = s.slice(3);
  } else if (s.startsWith('0091')) {
    s = s.slice(4);
  } else if (s.length === 12 && s.startsWith('91')) {
    s = s.slice(2);
  } else if (s.length === 11 && s.startsWith('0')) {
    s = s.slice(1);
  }
  return /^[6-9][0-9]{9}$/.test(s) ? `+91${s}` : null;
}

/** "+919876543210" -> "98765 43210" for display. */
export function formatMobileDisplay(e164: string): string {
  const m = /^\+91([0-9]{5})([0-9]{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}

const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]{1,99}$/u;
const SCHOOL_RE = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'’&()/:-]{1,149}$/u;
const ROLL_RE = /^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,19}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function validateRegistrationInput(raw: unknown, ctx: ValidationContext): ValidationResult {
  const errors: FieldErrors = {};
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  // 1. Full name
  const nameRaw = asString(input.fullName);
  const fullName = nameRaw === null ? '' : collapseWhitespace(nameRaw);
  if (fullName === '') errors.fullName = 'Enter the student’s full name.';
  else if (!NAME_RE.test(fullName)) {
    errors.fullName = 'Use letters, spaces, dots, hyphens or apostrophes only (2–100 characters).';
  }

  // 2. School
  const schoolRaw = asString(input.schoolName);
  let schoolName = schoolRaw === null ? '' : collapseWhitespace(schoolRaw);
  if (schoolName === '') errors.schoolName = 'Select or enter the school name.';
  else if (ctx.approvedSchools.length > 0) {
    const key = schoolKey(schoolName);
    const match = ctx.approvedSchools.find((s) => schoolKey(s) === key);
    if (!match) errors.schoolName = 'Select your school from the list.';
    else schoolName = collapseWhitespace(match); // canonical spelling from the approved list
  } else if (!SCHOOL_RE.test(schoolName)) {
    errors.schoolName = 'School name contains unsupported characters (2–150 characters).';
  }

  // 3. Roll number — kept as text so leading zeros survive.
  const rollRaw = asString(input.rollNumber);
  const rollNumber = rollRaw === null ? '' : collapseWhitespace(rollRaw);
  if (rollNumber === '') errors.rollNumber = 'Enter the roll number.';
  else if (!ROLL_RE.test(rollNumber)) {
    errors.rollNumber = 'Use letters, digits, spaces, dots, slashes or hyphens only (up to 20 characters).';
  }

  // 4. Mobile
  const mobileRaw = asString(input.mobile);
  let mobile = '';
  if (mobileRaw === null || collapseWhitespace(mobileRaw) === '') errors.mobile = 'Enter a mobile number.';
  else {
    const normalized = normalizeIndianMobile(mobileRaw);
    if (!normalized) errors.mobile = 'Enter a valid 10-digit Indian mobile number starting with 6, 7, 8 or 9.';
    else mobile = normalized;
  }

  // 5. Class & shift — the class decides the shift; a mismatching shift is rejected.
  const classLevel = typeof input.classLevel === 'number' ? input.classLevel : Number.NaN;
  const shift = typeof input.shift === 'number' ? input.shift : Number.NaN;
  const schedule = Number.isInteger(classLevel) ? findSchedule(ctx.schedules, classLevel) : undefined;
  if (!schedule) errors.classShift = 'Select your class and examination shift.';
  else if (schedule.shift !== shift) errors.classShift = 'The selected shift does not match the class. Please choose again.';

  // 8. Declaration
  if (input.declaration !== true) errors.declaration = 'You must accept the declaration to submit.';

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { fullName, schoolName, rollNumber, mobile, classLevel, shift },
  };
}
