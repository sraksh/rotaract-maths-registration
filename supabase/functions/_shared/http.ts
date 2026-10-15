/** HTTP plumbing: CORS, JSON envelope, error mapping, request logging. */
import { AppError, DependencyError, HTTP_STATUS, DEFAULT_MESSAGES, type ApiFailure, type ApiSuccess, type ErrorCode } from './errors.ts';
import type { HandlerDeps, RpcClient } from './types.ts';

const MAX_BODY_CHARS = 200_000;

export interface RequestContext {
  requestId: string;
  ip: string;
  /** Set by routes so the request log can name the action. */
  action: string;
}

export type Route = (req: Request, ctx: RequestContext) => Promise<unknown>;

export function corsHeaders(req: Request, allowedOrigins: readonly string[]): Record<string, string> {
  const origin = req.headers.get('origin');
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (origin && allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'authorization, apikey, content-type, x-client-info';
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}

/** Best-effort client IP. Supabase's gateway sets cf-connecting-ip / x-forwarded-for. */
export function clientIp(req: Request): string {
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return 'unknown';
}

export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new AppError('INVALID_REQUEST');
  }
  if (text.length === 0 || text.length > MAX_BODY_CHARS) throw new AppError('INVALID_REQUEST');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError('INVALID_REQUEST');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new AppError('INVALID_REQUEST');
  return parsed as Record<string, unknown>;
}

function json(status: number, body: ApiSuccess<unknown> | ApiFailure, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

/** Parses a database-raised 'app_error:<CODE>:<detail>' message into an AppError. */
export function appErrorFromDb(err: DependencyError): AppError | null {
  const m = /app_error:([A-Z_]+):?(.*)$/s.exec(err.message);
  if (!m) return null;
  const code = m[1] as ErrorCode;
  if (!(code in HTTP_STATUS)) return null;
  const detail = (m[2] ?? '').trim();
  if (code === 'NOT_READY') {
    const missing = detail === '' ? [] : detail.split(',');
    return new AppError('NOT_READY', DEFAULT_MESSAGES.NOT_READY, { details: { missing } });
  }
  return new AppError(code);
}

/** Wraps an RpcClient so database-raised business errors become AppErrors. */
export function withAppErrors(db: RpcClient): RpcClient {
  return {
    async rpc<T>(name: string, params?: Record<string, unknown>): Promise<T> {
      try {
        return await db.rpc<T>(name, params);
      } catch (e) {
        if (e instanceof DependencyError && e.dependency === 'database') {
          const mapped = appErrorFromDb(e);
          if (mapped) throw mapped;
          // Constraint / type violations raised by a malformed payload are a request problem.
          if (e.sqlstate && /^(22|23)/.test(e.sqlstate)) throw new AppError('VALIDATION_FAILED');
        }
        throw e;
      }
    },
  };
}

/**
 * Builds a fetch-style handler: CORS preflight, POST-only, JSON envelope, typed
 * error responses, and structured logging that never includes request bodies.
 */
export function createHandler(deps: HandlerDeps, fnName: string, route: Route): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const started = deps.now().getTime();
    const ctx: RequestContext = { requestId: deps.randomUUID(), ip: clientIp(req), action: 'unknown' };
    const cors = corsHeaders(req, deps.config.allowedOrigins);
    const baseHeaders = { ...cors, 'x-request-id': ctx.requestId };

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: baseHeaders });

    let status = 200;
    let code: string | undefined;
    let response: Response;
    try {
      if (req.method !== 'POST') throw new AppError('METHOD_NOT_ALLOWED');
      const data = await route(req, ctx);
      response = json(200, { ok: true, data }, baseHeaders);
    } catch (e) {
      let appErr: AppError;
      if (e instanceof AppError) appErr = e;
      else if (e instanceof DependencyError) {
        appErr = new AppError('UNAVAILABLE');
        deps.log('error', 'dependency_failure', { fn: fnName, requestId: ctx.requestId, dependency: e.dependency, sqlstate: e.sqlstate });
      } else {
        appErr = new AppError('INTERNAL');
        deps.log('error', 'unhandled_error', {
          fn: fnName,
          requestId: ctx.requestId,
          errorName: e instanceof Error ? e.name : typeof e,
        });
      }
      status = HTTP_STATUS[appErr.code];
      code = appErr.code;
      const headers: Record<string, string> = { ...baseHeaders };
      if (appErr.retryAfterSeconds !== undefined) headers['Retry-After'] = String(appErr.retryAfterSeconds);
      response = json(status, { ok: false, error: appErr.toBody(), requestId: ctx.requestId }, headers);
    }

    deps.log(status >= 500 ? 'error' : 'info', 'request', {
      fn: fnName,
      action: ctx.action,
      status,
      code,
      requestId: ctx.requestId,
      durationMs: deps.now().getTime() - started,
    });
    return response;
  };
}
