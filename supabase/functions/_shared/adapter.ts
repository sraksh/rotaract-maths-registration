/**
 * Production wiring: adapts a supabase-js client (service role) to the
 * dependency interfaces used by the handlers. Declared structurally so this file
 * has no import of the library and can be type-checked and unit-tested anywhere.
 */
import { DependencyError } from './errors.ts';
import { DEFAULT_CONFIG, type AuthVerifier, type HandlerConfig, type HandlerDeps, type Logger, type RpcClient, type StorageClient } from './types.ts';

interface SbError {
  message: string;
  code?: string;
  status?: number;
  statusCode?: string | number;
}
type SbResult<T> = PromiseLike<{ data: T | null; error: SbError | null }>;

export interface SupabaseLike {
  rpc(name: string, args?: Record<string, unknown>): SbResult<unknown>;
  storage: {
    from(bucket: string): {
      createSignedUploadUrl(path: string, options?: { upsert: boolean }): SbResult<{ signedUrl: string; token: string; path: string }>;
      download(path: string): SbResult<Blob>;
      remove(paths: string[]): SbResult<unknown>;
      createSignedUrl(path: string, expiresIn: number): SbResult<{ signedUrl: string }>;
    };
  };
  auth: {
    getUser(jwt?: string): PromiseLike<{ data: { user: { id: string; email?: string | null } | null }; error: SbError | null }>;
  };
}

function isNotFound(e: SbError): boolean {
  return String(e.status) === '404' || String(e.statusCode) === '404' || /not.?found/i.test(e.message);
}

export function makeRpcClient(client: SupabaseLike): RpcClient {
  return {
    async rpc<T>(name: string, params?: Record<string, unknown>): Promise<T> {
      const { data, error } = await client.rpc(name, params === undefined ? undefined : { p: params });
      if (error) throw new DependencyError('database', error.message, error.code);
      return data as T;
    },
  };
}

export function makeStorageClient(client: SupabaseLike): StorageClient {
  return {
    async createSignedUploadUrl(bucket, path) {
      const { data, error } = await client.storage.from(bucket).createSignedUploadUrl(path, { upsert: true });
      if (error || !data) throw new DependencyError('storage', error?.message ?? 'no data');
      return data;
    },
    async download(bucket, path) {
      const { data, error } = await client.storage.from(bucket).download(path);
      if (error) {
        if (isNotFound(error)) return null;
        throw new DependencyError('storage', error.message);
      }
      if (!data) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
    async remove(bucket, paths) {
      const { error } = await client.storage.from(bucket).remove(paths);
      if (error) throw new DependencyError('storage', error.message);
    },
    async createSignedUrl(bucket, path, expiresInSeconds) {
      const { data, error } = await client.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
      if (error || !data) throw new DependencyError('storage', error?.message ?? 'no data');
      return data.signedUrl;
    },
  };
}

export function makeAuthVerifier(client: SupabaseLike): AuthVerifier {
  return {
    async verifyAccessToken(token) {
      const { data, error } = await client.auth.getUser(token);
      if (error || !data.user) {
        // An invalid or expired token is an authentication failure; an outage is not.
        if (error && (Number(error.status) >= 500 || /fetch|network|timeout/i.test(error.message))) {
          throw new DependencyError('auth', error.message);
        }
        return null;
      }
      return { id: data.user.id, email: data.user.email ?? null };
    },
  };
}

export const consoleLogger: Logger = (level, event, meta) => {
  const line = JSON.stringify({ level, event, ...meta });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

/** Reads handler configuration through a getter so it works with Deno.env.get. */
export function loadHandlerConfig(get: (key: string) => string | undefined): HandlerConfig {
  const num = (key: string, fallback: number): number => {
    const v = Number(get(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    ...DEFAULT_CONFIG,
    allowedOrigins: (get('ALLOWED_ORIGINS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ipHashSalt: get('IP_HASH_SALT') ?? '',
    cleanupSecret: get('CLEANUP_SECRET') ?? '',
    rateLimitInitPer10Min: num('RATE_LIMIT_INIT_PER_10_MIN', DEFAULT_CONFIG.rateLimitInitPer10Min),
    rateLimitSubmitPer10Min: num('RATE_LIMIT_SUBMIT_PER_10_MIN', DEFAULT_CONFIG.rateLimitSubmitPer10Min),
    rateLimitAdmitPer10Min: num('RATE_LIMIT_ADMIT_PER_10_MIN', DEFAULT_CONFIG.rateLimitAdmitPer10Min),
  };
}

export function createSupabaseDeps(client: SupabaseLike, config: HandlerConfig): HandlerDeps {
  if (!config.ipHashSalt) {
    // Fail loudly rather than silently hashing IPs with an empty, guessable salt.
    throw new Error('IP_HASH_SALT is not configured. Set it with `supabase secrets set IP_HASH_SALT=...`.');
  }
  return {
    db: makeRpcClient(client),
    storage: makeStorageClient(client),
    auth: makeAuthVerifier(client),
    now: () => new Date(),
    randomUUID: () => crypto.randomUUID(),
    log: consoleLogger,
    config,
  };
}
