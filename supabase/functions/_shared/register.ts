/**
 * Public registration function.
 *
 *   action "init-upload"  -> issues a single-use signed upload URL for the private
 *                            payment-proofs bucket, bound to the idempotency key.
 *   action "submit"       -> re-verifies the uploaded object from its bytes, then
 *                            creates the registration atomically and idempotently.
 *
 * Nothing here trusts the browser: field values are re-validated, the class->shift
 * mapping and the times come from the database, the registration ID is generated in
 * the database, and the upload is verified by file signature before it is attached.
 */
import { AppError, type ErrorCode } from './errors.ts';
import { MAX_PROOF_BYTES, detectImageType, validateDeclaredFile, type DeclaredFile } from './files.ts';
import { canonicalJson, sha256Hex } from './hash.ts';
import { createHandler, readJsonObject, withAppErrors, type RequestContext } from './http.ts';
import type { InitUploadResult, PublicConfig, Receipt, SubmitResult } from './api.ts';
import type { HandlerDeps, RpcClient } from './types.ts';
import { isUuid, validateRegistrationInput } from './validation.ts';

type DbFailure = { ok: false; code: string };

function failureToError(code: string): AppError {
  switch (code as ErrorCode | 'SCHEDULE_MISMATCH') {
    case 'SCHEDULE_MISMATCH':
      return new AppError('VALIDATION_FAILED', undefined, {
        fields: { classShift: 'The selected shift does not match the class. Please choose again.' },
      });
    case 'REGISTRATION_CLOSED':
    case 'NOT_CONFIGURED':
    case 'UPLOAD_SESSION_INVALID':
    case 'UPLOAD_SESSION_EXPIRED':
    case 'IDEMPOTENCY_KEY_REUSED':
      return new AppError(code as ErrorCode);
    default:
      return new AppError('INTERNAL');
  }
}

async function enforceRateLimit(
  deps: HandlerDeps,
  db: RpcClient,
  ctx: RequestContext,
  bucket: string,
  limit: number,
): Promise<string> {
  const ipHash = await sha256Hex(`${deps.config.ipHashSalt}:${ctx.ip}`);
  const res = await db.rpc<{ allowed: boolean; retry_after_seconds: number }>('check_rate_limit', {
    bucket: `${bucket}:${ipHash}`,
    limit,
    window_seconds: 600,
  });
  if (!res.allowed) throw new AppError('RATE_LIMITED', undefined, { retryAfterSeconds: res.retry_after_seconds });
  return ipHash;
}

function declaredFileFrom(raw: unknown): DeclaredFile {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    fileName: typeof o.fileName === 'string' ? o.fileName : '',
    contentType: typeof o.contentType === 'string' ? o.contentType : '',
    sizeBytes: typeof o.sizeBytes === 'number' ? o.sizeBytes : Number.NaN,
  };
}

async function initUpload(deps: HandlerDeps, db: RpcClient, body: Record<string, unknown>, ctx: RequestContext): Promise<InitUploadResult> {
  const ipHash = await enforceRateLimit(deps, db, ctx, 'init', deps.config.rateLimitInitPer10Min);

  if (!isUuid(body.idempotencyKey)) throw new AppError('INVALID_REQUEST');
  const problem = validateDeclaredFile(declaredFileFrom(body.file));
  if (problem) throw new AppError('VALIDATION_FAILED', problem, { fields: { paymentScreenshot: problem } });

  // The path is chosen by the server and is random and non-guessable. If a slot
  // already exists for this key it keeps its original path (re-upload overwrites).
  const candidatePath = `proofs/${deps.randomUUID()}`;
  const res = await db.rpc<
    | { ok: true; replay: true; registration: Receipt }
    | { ok: true; replay: false; session_id: string; proof_path: string; expires_at: string }
    | DbFailure
  >('create_upload_session', {
    idempotency_key: body.idempotencyKey,
    proof_path: candidatePath,
    ip_hash: ipHash,
    ttl_seconds: deps.config.uploadTtlSeconds,
  });
  if (!res.ok) throw failureToError(res.code);
  if (res.replay) return { replay: true, registration: res.registration };

  const signed = await deps.storage.createSignedUploadUrl(deps.config.proofBucket, res.proof_path);
  return {
    replay: false,
    uploadSessionId: res.session_id,
    bucket: deps.config.proofBucket,
    path: res.proof_path,
    token: signed.token,
    expiresAt: res.expires_at,
    maxBytes: MAX_PROOF_BYTES,
  };
}

/** Removes a bad upload and lets the user upload again under the same session. */
async function rejectUpload(deps: HandlerDeps, db: RpcClient, ctx: RequestContext, sessionId: string, path: string, message: string): Promise<never> {
  try {
    await deps.storage.remove(deps.config.proofBucket, [path]);
  } catch {
    deps.log('warn', 'orphan_cleanup_failed', { requestId: ctx.requestId });
  }
  await db.rpc('mark_upload_rejected', { session_id: sessionId });
  throw new AppError('UPLOAD_INVALID', message, { fields: { paymentScreenshot: message } });
}

async function submit(deps: HandlerDeps, db: RpcClient, body: Record<string, unknown>, ctx: RequestContext): Promise<SubmitResult> {
  await enforceRateLimit(deps, db, ctx, 'submit', deps.config.rateLimitSubmitPer10Min);

  if (!isUuid(body.idempotencyKey) || !isUuid(body.uploadSessionId)) throw new AppError('INVALID_REQUEST');
  const idempotencyKey = body.idempotencyKey;
  const sessionId = body.uploadSessionId;

  // 1. Re-validate everything against the server's own configuration.
  const cfg = await db.rpc<PublicConfig>('get_public_config');
  const parsed = validateRegistrationInput(body.registration, {
    approvedSchools: cfg.schools ?? [],
    schedules: cfg.schedules ?? [],
  });
  if (!parsed.ok) throw new AppError('VALIDATION_FAILED', undefined, { fields: parsed.errors });
  const v = parsed.value;

  const requestHash = await sha256Hex(canonicalJson({ ...v, uploadSessionId: sessionId }));

  // 2. Verify the upload that belongs to THIS idempotency key.
  const session = await db.rpc<{ found: boolean; status?: string; proof_path?: string; expired?: boolean }>('get_upload_session', {
    idempotency_key: idempotencyKey,
    session_id: sessionId,
  });
  if (!session.found || !session.proof_path) throw new AppError('UPLOAD_SESSION_INVALID');

  let contentType = 'image/jpeg';
  let sizeBytes = 1;
  if (session.status === 'issued') {
    if (session.expired) throw new AppError('UPLOAD_SESSION_EXPIRED');
    const bytes = await deps.storage.download(deps.config.proofBucket, session.proof_path);
    if (bytes === null) {
      const msg = 'The payment screenshot was not received. Please select it again.';
      throw new AppError('UPLOAD_MISSING', msg, { fields: { paymentScreenshot: msg } });
    }
    if (bytes.length === 0 || bytes.length > MAX_PROOF_BYTES) {
      return rejectUpload(deps, db, ctx, sessionId, session.proof_path, 'The screenshot must be an image of 5 MB or less.');
    }
    const detected = detectImageType(bytes);
    if (!detected) {
      return rejectUpload(deps, db, ctx, sessionId, session.proof_path, 'The file is not a valid JPG, PNG or WEBP image.');
    }
    contentType = detected;
    sizeBytes = bytes.length;
  } else if (session.status === 'rejected') {
    const msg = 'The previous upload was rejected. Please select the screenshot again.';
    throw new AppError('UPLOAD_MISSING', msg, { fields: { paymentScreenshot: msg } });
  }
  // status === 'consumed': a replay; create_registration returns the saved record
  // after checking the request hash, so no storage access is needed.

  // 3. Create atomically (idempotent, server-generated ID, DB-derived schedule).
  const res = await db.rpc<{ ok: true; replayed: boolean; registration: Receipt } | DbFailure>('create_registration', {
    idempotency_key: idempotencyKey,
    session_id: sessionId,
    request_hash: requestHash,
    full_name: v.fullName,
    school_name: v.schoolName,
    roll_number: v.rollNumber,
    mobile: v.mobile,
    class_level: v.classLevel,
    shift: v.shift,
    proof_content_type: contentType,
    proof_size_bytes: sizeBytes,
  });
  if (!res.ok) throw failureToError(res.code);

  deps.log('info', 'registration_saved', {
    requestId: ctx.requestId,
    registrationId: res.registration.registrationId,
    replayed: res.replayed,
  });
  return { registration: res.registration, replayed: res.replayed };
}

export function createRegisterHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const db = withAppErrors(deps.db);
  return createHandler(deps, 'register', async (req, ctx) => {
    const body = await readJsonObject(req);
    const action = body.action;
    if (action === 'init-upload') {
      ctx.action = 'init-upload';
      return initUpload(deps, db, body, ctx);
    }
    if (action === 'submit') {
      ctx.action = 'submit';
      return submit(deps, db, body, ctx);
    }
    throw new AppError('INVALID_REQUEST');
  });
}
