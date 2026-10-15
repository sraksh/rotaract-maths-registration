/**
 * Dependency-injection seams for the Edge Function handlers.
 *
 * Production wiring (supabase-js against a real project) lives in adapter.ts and
 * the functions' index.ts files. Tests and the local e2e backend supply their own
 * implementations, so the SAME handler code runs everywhere.
 */

export interface RpcClient {
  /**
   * Calls a database function. `params` is the single jsonb argument; omit it for
   * zero-argument functions. Throws DependencyError('database') on failure.
   */
  rpc<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
}

export interface StorageClient {
  /** Creates a single-use signed upload URL for `path` (overwriting allowed). */
  createSignedUploadUrl(bucket: string, path: string): Promise<{ signedUrl: string; token: string; path: string }>;
  /** Full object bytes, or null if the object does not exist. */
  download(bucket: string, path: string): Promise<Uint8Array | null>;
  remove(bucket: string, paths: string[]): Promise<void>;
  createSignedUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string>;
}

export interface VerifiedUser {
  id: string;
  email: string | null;
}

export interface AuthVerifier {
  /** Returns the user for a valid, unexpired access token; null otherwise. */
  verifyAccessToken(token: string): Promise<VerifiedUser | null>;
}

export type LogLevel = 'info' | 'warn' | 'error';
export type LogMeta = Record<string, string | number | boolean | null | undefined>;
/** Structured logging. Callers must never pass student data, files or secrets. */
export type Logger = (level: LogLevel, event: string, meta?: LogMeta) => void;

export interface HandlerConfig {
  /** Browser origins allowed by CORS (CORS is NOT authentication). */
  allowedOrigins: readonly string[];
  /** Secret salt mixed into client-IP hashes used for rate limiting. */
  ipHashSalt: string;
  proofBucket: string;
  qrBucket: string;
  signedUrlTtlSeconds: number;
  uploadTtlSeconds: number;
  rateLimitInitPer10Min: number;
  rateLimitSubmitPer10Min: number;
  /** Shared secret for the scheduled cleanup function. */
  cleanupSecret: string;
}

export interface HandlerDeps {
  db: RpcClient;
  storage: StorageClient;
  auth: AuthVerifier;
  now: () => Date;
  randomUUID: () => string;
  log: Logger;
  config: HandlerConfig;
}

export const DEFAULT_CONFIG: Omit<HandlerConfig, 'ipHashSalt' | 'cleanupSecret' | 'allowedOrigins'> = {
  proofBucket: 'payment-proofs',
  qrBucket: 'payment-qr',
  signedUrlTtlSeconds: 60,
  uploadTtlSeconds: 3600,
  rateLimitInitPer10Min: 30,
  rateLimitSubmitPer10Min: 30,
};
