/**
 * Administrator function. EVERY request is authenticated (a valid, unexpired
 * Supabase access token) and authorised (an active row in admin_users) in this
 * server-side code before any action runs. Hiding buttons in the UI is not relied on.
 */
import { AppError } from './errors.ts';
import { MAX_QR_BYTES, detectImageType, validateDeclaredFile, type DeclaredFile } from './files.ts';
import { createHandler, readJsonObject, withAppErrors, type RequestContext } from './http.ts';
import { CLASS_LEVELS, isHHMM, validateSchedules, type ExamSchedule } from './schedule.ts';
import type {
  AdminConfig,
  ExportResult,
  ListResult,
  RegistrationDetail,
  RegistrationFilters,
  StatsResult,
} from './api.ts';
import type { HandlerDeps, RpcClient, VerifiedUser } from './types.ts';
import { UPI_ID_RE, collapseWhitespace, schoolKey } from './validation.ts';

const REGISTRATION_ID_RE = /^PRM34-[0-9A-F]{10}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['pending', 'verified', 'rejected'] as const;

interface Actor extends VerifiedUser {
  /** Email as recorded in admin_users (falls back to the token's email). */
  recordedEmail: string | null;
}

// ------------------------------------------------------------------ parsing --

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function bad(field: string, message: string): never {
  throw new AppError('VALIDATION_FAILED', message, { fields: { [field]: message } });
}

function registrationIdOf(body: Record<string, unknown>): string {
  const id = body.registrationId;
  if (typeof id !== 'string' || !REGISTRATION_ID_RE.test(id)) throw new AppError('INVALID_REQUEST');
  return id;
}

/** Validates the filter object and converts it to the database's snake_case keys. */
export function parseFilters(raw: unknown): Record<string, unknown> {
  const f = obj(raw) as Partial<Record<keyof RegistrationFilters, unknown>>;
  const out: Record<string, unknown> = {};

  if (f.q !== undefined && f.q !== null && f.q !== '') {
    if (typeof f.q !== 'string' || f.q.length > 100) bad('q', 'Search text must be 100 characters or fewer.');
    out.q = f.q.trim();
  }
  if (f.classLevel !== undefined && f.classLevel !== null && f.classLevel !== '') {
    if (typeof f.classLevel !== 'number' || !(CLASS_LEVELS as readonly number[]).includes(f.classLevel)) {
      bad('classLevel', 'Class must be 7, 8, 9 or 10.');
    }
    out.class_level = f.classLevel;
  }
  if (f.school !== undefined && f.school !== null && f.school !== '') {
    if (typeof f.school !== 'string' || f.school.length > 150) bad('school', 'Invalid school filter.');
    out.school = f.school;
  }
  if (f.status !== undefined && f.status !== null && f.status !== '') {
    if (typeof f.status !== 'string' || !(STATUSES as readonly string[]).includes(f.status)) bad('status', 'Invalid status filter.');
    out.status = f.status;
  }
  for (const key of ['from', 'to'] as const) {
    const v = f[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || !isRealDate(v)) bad('dateRange', 'Dates must be valid and formatted YYYY-MM-DD.');
    out[key] = v;
  }
  if (typeof out.from === 'string' && typeof out.to === 'string' && out.from > out.to) {
    bad('dateRange', 'The start date must not be after the end date.');
  }
  return out;
}

function parseConfigPatch(raw: Record<string, unknown>): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);

  const text = (key: string, field: string, min: number, max: number, nullable = false): void => {
    if (!has(key)) return;
    const v = raw[key];
    if (v === null || v === '') {
      if (nullable) {
        p[field] = null;
        return;
      }
      bad(key, 'This field is required.');
    }
    if (typeof v !== 'string') bad(key, 'Must be text.');
    const s = collapseWhitespace(v as string);
    if (s.length < min || s.length > max) bad(key, `Must be ${min}–${max} characters.`);
    p[field] = s;
  };

  text('eventName', 'event_name', 3, 200);
  text('organiser', 'organiser', 2, 200);
  text('venue', 'venue', 2, 300, true);
  text('upiPayeeName', 'upi_payee_name', 2, 120, true);

  if (has('eventDate')) {
    if (typeof raw.eventDate !== 'string' || !isRealDate(raw.eventDate)) bad('eventDate', 'Enter a valid date.');
    p.event_date = raw.eventDate;
  }
  for (const [key, field] of [['venueConfirmed', 'venue_confirmed'], ['registrationOpen', 'registration_open']] as const) {
    if (!has(key)) continue;
    if (typeof raw[key] !== 'boolean') bad(key, 'Must be true or false.');
    p[field] = raw[key];
  }
  if (has('feeAmount')) {
    const v = raw.feeAmount;
    if (v === null || v === '') p.fee_amount = null;
    else {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 100000) bad('feeAmount', 'Enter an amount greater than 0.');
      if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) bad('feeAmount', 'Use at most two decimal places.');
      p.fee_amount = Math.round((v as number) * 100) / 100;
    }
  }
  if (has('upiId')) {
    const v = raw.upiId;
    if (v === null || v === '') p.upi_id = null;
    else {
      if (typeof v !== 'string' || !UPI_ID_RE.test(v.trim())) bad('upiId', 'Enter a valid UPI ID such as name@bank.');
      p.upi_id = (v as string).trim();
    }
  }
  if (has('schools')) {
    const v = raw.schools;
    if (!Array.isArray(v) || v.length > 3000) bad('schools', 'Provide the school list as an array of up to 3000 names.');
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const item of v as unknown[]) {
      if (typeof item !== 'string') bad('schools', 'Every school must be text.');
      const name = collapseWhitespace(item as string);
      if (name === '') continue;
      if (name.length < 2 || name.length > 150) bad('schools', `"${name.slice(0, 40)}" must be 2–150 characters.`);
      const key = schoolKey(name);
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(name);
    }
    p.schools = cleaned;
  }
  if (has('schedules')) {
    const v = raw.schedules;
    if (!Array.isArray(v)) bad('schedules', 'Schedules must be an array.');
    const list: ExamSchedule[] = (v as unknown[]).map((item) => {
      const o = obj(item);
      return {
        classLevel: o.classLevel as ExamSchedule['classLevel'],
        shift: o.shift as ExamSchedule['shift'],
        examStart: String(o.examStart),
        examEnd: String(o.examEnd),
        reportingTime: String(o.reportingTime),
      };
    });
    for (const s of list) {
      if (!isHHMM(s.examStart) || !isHHMM(s.examEnd) || !isHHMM(s.reportingTime)) {
        bad('schedules', 'Times must be in HH:MM (24-hour) format.');
      }
    }
    const problems = validateSchedules(list);
    if (problems.length > 0) bad('schedules', problems[0]!);
    p.schedules = list;
  }
  return p;
}

// ---------------------------------------------------------------- actions ----

async function authenticate(deps: HandlerDeps, db: RpcClient, req: Request): Promise<Actor> {
  const header = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) throw new AppError('UNAUTHENTICATED');
  const user = await deps.auth.verifyAccessToken(m[1]!);
  if (!user) throw new AppError('UNAUTHENTICATED');

  const lookup = await db.rpc<{ is_admin: boolean; email?: string }>('admin_lookup', { user_id: user.id });
  if (!lookup.is_admin) {
    deps.log('warn', 'admin_access_denied', { userId: user.id });
    throw new AppError('FORBIDDEN');
  }
  return { ...user, recordedEmail: lookup.email ?? user.email };
}

export function createAdminHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const db = withAppErrors(deps.db);

  return createHandler(deps, 'admin', async (req: Request, ctx: RequestContext) => {
    const actor = await authenticate(deps, db, req);
    const body = await readJsonObject(req);
    const action = typeof body.action === 'string' ? body.action : '';
    ctx.action = action;
    const actorArgs = { actor_id: actor.id, actor_email: actor.recordedEmail };

    switch (action) {
      case 'stats':
        return db.rpc<StatsResult>('admin_stats', {});

      case 'list': {
        const page = typeof body.page === 'number' && Number.isInteger(body.page) && body.page >= 1 ? body.page : 1;
        const pageSize = typeof body.pageSize === 'number' && Number.isInteger(body.pageSize) ? Math.min(Math.max(body.pageSize, 1), 100) : 25;
        return db.rpc<ListResult>('admin_list_registrations', { ...parseFilters(body.filters), page, page_size: pageSize });
      }

      case 'detail': {
        const res = await db.rpc<{ found: boolean; registration?: RegistrationDetail }>('admin_get_registration', {
          registration_id: registrationIdOf(body),
        });
        if (!res.found) throw new AppError('NOT_FOUND');
        return res.registration;
      }

      case 'set-payment-status': {
        const newStatus = body.newStatus;
        const expected = body.expectedStatus;
        if (newStatus !== 'verified' && newStatus !== 'rejected') bad('newStatus', 'Choose verified or rejected.');
        if (typeof expected !== 'string' || !(STATUSES as readonly string[]).includes(expected)) throw new AppError('INVALID_REQUEST');
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (newStatus === 'rejected' && reason.length < 3) {
          bad('reason', 'A reason of at least 3 characters is required to reject a payment proof.');
        }
        const payload: Record<string, unknown> = {
          ...actorArgs,
          registration_id: registrationIdOf(body),
          expected_status: expected,
          new_status: newStatus,
          reason: reason === '' ? null : reason,
        };
        if (Object.prototype.hasOwnProperty.call(body, 'note')) {
          if (body.note !== null && typeof body.note !== 'string') bad('note', 'The note must be text.');
          payload.note = body.note;
        }
        const res = await db.rpc<
          | { ok: true; registration: RegistrationDetail }
          | { ok: false; code: string; fields?: Record<string, string>; current_status?: string; registration?: RegistrationDetail }
        >('admin_set_payment_status', payload);
        if (res.ok) return res.registration;
        if (res.code === 'STATUS_CONFLICT') {
          throw new AppError('STATUS_CONFLICT', undefined, {
            details: { currentStatus: res.current_status ?? null, registration: (res.registration ?? null) as unknown as Record<string, unknown> | null },
          });
        }
        if (res.code === 'VALIDATION_FAILED') throw new AppError('VALIDATION_FAILED', undefined, { fields: res.fields ?? {} });
        if (res.code === 'NOT_FOUND') throw new AppError('NOT_FOUND');
        if (res.code === 'NO_CHANGE') throw new AppError('NO_CHANGE');
        throw new AppError('INTERNAL');
      }

      case 'update-note': {
        if (body.note !== null && typeof body.note !== 'string') bad('note', 'The note must be text.');
        const res = await db.rpc<{ ok: true; registration: RegistrationDetail } | { ok: false; code: string; fields?: Record<string, string> }>(
          'admin_update_note',
          { ...actorArgs, registration_id: registrationIdOf(body), note: body.note },
        );
        if (res.ok) return res.registration;
        if (res.code === 'NOT_FOUND') throw new AppError('NOT_FOUND');
        throw new AppError('VALIDATION_FAILED', undefined, { fields: res.fields ?? {} });
      }

      case 'proof-url': {
        const res = await db.rpc<{ found: boolean; proof_path?: string; content_type?: string }>('admin_get_proof_path', {
          ...actorArgs,
          registration_id: registrationIdOf(body),
        });
        if (!res.found || !res.proof_path) throw new AppError('NOT_FOUND');
        const url = await deps.storage.createSignedUrl(deps.config.proofBucket, res.proof_path, deps.config.signedUrlTtlSeconds);
        return { url, expiresInSeconds: deps.config.signedUrlTtlSeconds, contentType: res.content_type ?? null };
      }

      case 'get-config':
        return db.rpc<AdminConfig>('admin_get_config', {});

      case 'update-config': {
        const patch = parseConfigPatch(obj(body.config));
        if (Object.keys(patch).length === 0) throw new AppError('INVALID_REQUEST');
        await db.rpc('admin_update_config', { ...actorArgs, ...patch });
        return db.rpc<AdminConfig>('admin_get_config', {});
      }

      case 'qr-upload-init': {
        const o = obj(body.file);
        const file: DeclaredFile = {
          fileName: typeof o.fileName === 'string' ? o.fileName : '',
          contentType: typeof o.contentType === 'string' ? o.contentType : '',
          sizeBytes: typeof o.sizeBytes === 'number' ? o.sizeBytes : Number.NaN,
        };
        const problem = validateDeclaredFile(file, MAX_QR_BYTES);
        if (problem) bad('qrImage', problem);
        const path = `qr/${deps.randomUUID()}`;
        const signed = await deps.storage.createSignedUploadUrl(deps.config.qrBucket, path);
        return { bucket: deps.config.qrBucket, path, token: signed.token };
      }

      case 'qr-commit': {
        const path = body.path;
        if (typeof path !== 'string' || !/^qr\/[0-9a-f-]{36}$/i.test(path)) throw new AppError('INVALID_REQUEST');
        const bytes = await deps.storage.download(deps.config.qrBucket, path);
        if (bytes === null) bad('qrImage', 'The QR image was not received. Please upload it again.');
        if (bytes!.length === 0 || bytes!.length > MAX_QR_BYTES || detectImageType(bytes!) === null) {
          await deps.storage.remove(deps.config.qrBucket, [path]).catch(() => undefined);
          bad('qrImage', 'The QR image must be a valid JPG, PNG or WEBP file under 2 MB.');
        }
        const res = await db.rpc<{ ok: true; previous_path: string | null }>('admin_set_qr_path', { ...actorArgs, path });
        if (res.previous_path && res.previous_path !== path) {
          await deps.storage.remove(deps.config.qrBucket, [res.previous_path]).catch(() => {
            deps.log('warn', 'old_qr_cleanup_failed', { requestId: ctx.requestId });
          });
        }
        return { qrImagePath: path };
      }

      case 'export': {
        const format = body.format === 'csv' || body.format === 'xlsx' || body.format === 'print' ? body.format : 'unknown';
        const includeNotes = body.includeNotes === true;
        return db.rpc<ExportResult>('admin_export_rows', {
          ...actorArgs,
          ...parseFilters(body.filters),
          include_notes: includeNotes,
          format,
        });
      }

      default:
        throw new AppError('INVALID_REQUEST');
    }
  });
}
