import { formatTime12 } from '../../supabase/functions/_shared/schedule.ts';

const IST = 'Asia/Kolkata';

/** "13 Oct 2026, 4:30 PM" in India Standard Time. */
export function formatDateTimeIST(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    .format(d)
    .replace(/\b(am|pm)\b/i, (m) => m.toUpperCase()) + ' IST';
}

/** "22 November 2026" from a YYYY-MM-DD date (no time-zone shifting). */
export function formatDateLong(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

export function time12(hhmm: string): string {
  try {
    return formatTime12(hhmm);
  } catch {
    return hhmm;
  }
}

export function examWindow(start: string, end: string): string {
  return `${time12(start)}–${time12(end)}`;
}

export function statusLabel(s: string): string {
  return s === 'pending' ? 'Pending verification' : s === 'verified' ? 'Verified' : s === 'rejected' ? 'Rejected' : s;
}

export function formatRupees(n: number): string {
  return `₹${new Intl.NumberFormat('en-IN', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).format(n)}`;
}

export function bytesLabel(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Today's date (YYYY-MM-DD) in IST, for file names. */
export function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
