/** Typed client for the `register` and `admin` Edge Functions. */
import type { ApiErrorBody, ErrorCode } from '../../supabase/functions/_shared/errors.ts';
import type {
  AdminConfig,
  AdmitCard,
  ExportResult,
  InitUploadResult,
  ListResult,
  PublicConfig,
  RegistrationDetail,
  RegistrationFilters,
  StatsResult,
  SubmitResult,
} from '../../supabase/functions/_shared/api.ts';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './env';
import { getSupabase } from './supabase';

export type ClientErrorCode = ErrorCode | 'NETWORK' | 'TIMEOUT';

export class ApiError extends Error {
  readonly code: ClientErrorCode;
  readonly fields: Record<string, string>;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: ClientErrorCode, message: string, opts: { fields?: Record<string, string>; retryable?: boolean; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.fields = opts.fields ?? {};
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }
}

const TIMEOUT_MS = 30_000;

async function callFunction<T>(name: 'register' | 'admin', body: unknown, accessToken?: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_PUBLISHABLE_KEY,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError('TIMEOUT', 'The server took too long to respond. Your details are kept; please try again.', { retryable: true });
    }
    throw new ApiError('NETWORK', 'Could not reach the server. Check your internet connection and try again. Your details are kept.', { retryable: true });
  } finally {
    clearTimeout(timer);
  }

  type Envelope = { ok?: boolean; data?: T; error?: ApiErrorBody };
  const json: Envelope | null = await res.json().then(
    (v: unknown) => v as Envelope,
    () => null,
  );
  if (json?.ok === true) return json.data as T;
  if (json?.error) {
    throw new ApiError(json.error.code, json.error.message, {
      fields: json.error.fields ?? {},
      retryable: json.error.retryable,
      details: json.error.details,
    });
  }
  throw new ApiError('UNAVAILABLE', 'The service is temporarily unavailable. Please try again in a moment.', { retryable: true });
}

// ----------------------------------------------------------------- public ----

export async function fetchPublicConfig(): Promise<PublicConfig> {
  const { data, error } = await getSupabase().rpc('get_public_config');
  if (error || !data) throw new ApiError('UNAVAILABLE', 'Could not load registration settings. Please refresh and try again.', { retryable: true });
  return data as PublicConfig;
}

export interface UploadFileMeta {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export function initUpload(idempotencyKey: string, file: UploadFileMeta): Promise<InitUploadResult> {
  return callFunction('register', { action: 'init-upload', idempotencyKey, file });
}

export async function uploadProof(init: Required<Pick<InitUploadResult, 'bucket' | 'path' | 'token'>>, file: File): Promise<void> {
  const { error } = await getSupabase().storage.from(init.bucket).uploadToSignedUrl(init.path, init.token, file, { contentType: file.type });
  if (error) throw new ApiError('NETWORK', 'The screenshot could not be uploaded. Please check your connection and try again.', { retryable: true });
}

export function submitRegistration(body: {
  idempotencyKey: string;
  uploadSessionId: string;
  registration: Record<string, unknown>;
}): Promise<SubmitResult> {
  return callFunction('register', { action: 'submit', ...body });
}

export function fetchAdmitCard(registrationId: string, mobile: string): Promise<AdmitCard> {
  return callFunction('register', { action: 'admit-card', registrationId, mobile });
}

export function publicQrUrl(path: string): string {
  return getSupabase().storage.from('payment-qr').getPublicUrl(path).data.publicUrl;
}

// ------------------------------------------------------------------ admin ----

async function adminCall<T>(body: Record<string, unknown>): Promise<T> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
  return callFunction<T>('admin', body, token);
}

export const admin = {
  stats: () => adminCall<StatsResult>({ action: 'stats' }),
  list: (filters: RegistrationFilters, page: number, pageSize: number) =>
    adminCall<ListResult>({ action: 'list', filters, page, pageSize }),
  detail: (registrationId: string) => adminCall<RegistrationDetail>({ action: 'detail', registrationId }),
  setPaymentStatus: (args: {
    registrationId: string;
    expectedStatus: string;
    newStatus: 'verified' | 'rejected';
    reason?: string;
    note?: string | null;
  }) => adminCall<RegistrationDetail>({ action: 'set-payment-status', ...args }),
  updateNote: (registrationId: string, note: string | null) =>
    adminCall<RegistrationDetail>({ action: 'update-note', registrationId, note }),
  proofUrl: (registrationId: string) =>
    adminCall<{ url: string; expiresInSeconds: number; contentType: string | null }>({ action: 'proof-url', registrationId }),
  getConfig: () => adminCall<AdminConfig>({ action: 'get-config' }),
  updateConfig: (config: Record<string, unknown>) => adminCall<AdminConfig>({ action: 'update-config', config }),
  qrUploadInit: (file: UploadFileMeta) => adminCall<{ bucket: string; path: string; token: string }>({ action: 'qr-upload-init', file }),
  qrCommit: (path: string) => adminCall<{ qrImagePath: string }>({ action: 'qr-commit', path }),
  exportRows: (filters: RegistrationFilters, format: 'csv' | 'xlsx' | 'print', includeNotes: boolean) =>
    adminCall<ExportResult>({ action: 'export', filters, format, includeNotes }),
};

export async function uploadQr(file: File): Promise<void> {
  const init = await admin.qrUploadInit({ fileName: file.name, contentType: file.type, sizeBytes: file.size });
  const { error } = await getSupabase().storage.from(init.bucket).uploadToSignedUrl(init.path, init.token, file, { contentType: file.type });
  if (error) throw new ApiError('NETWORK', 'The QR image could not be uploaded. Please try again.', { retryable: true });
  await admin.qrCommit(init.path);
}
