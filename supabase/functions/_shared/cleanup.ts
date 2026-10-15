/**
 * Scheduled maintenance: deletes upload objects (and their sessions) that were
 * never attached to a registration, and prunes old rate-limit windows.
 * Protected by a shared secret header; intended for a Supabase cron schedule.
 */
import { AppError } from './errors.ts';
import { timingSafeEqual } from './hash.ts';
import { createHandler, withAppErrors } from './http.ts';
import type { HandlerDeps } from './types.ts';

export function createCleanupHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const db = withAppErrors(deps.db);
  return createHandler(deps, 'cleanup', async (req, ctx) => {
    ctx.action = 'cleanup';
    const secret = deps.config.cleanupSecret;
    if (!secret) throw new AppError('NOT_CONFIGURED', 'The cleanup secret is not configured.');
    const provided = req.headers.get('x-cleanup-secret') ?? '';
    if (!timingSafeEqual(provided, secret)) throw new AppError('UNAUTHENTICATED');

    const claimed = await db.rpc<{ id: string; proof_path: string }[]>('claim_expired_upload_sessions', {
      grace_seconds: 3600,
      limit: 200,
    });
    const deletable: string[] = [];
    let removedObjects = 0;
    for (const item of claimed) {
      try {
        await deps.storage.remove(deps.config.proofBucket, [item.proof_path]);
        removedObjects += 1;
        deletable.push(item.id);
      } catch {
        // Keep the session so the next run retries the object removal.
        deps.log('warn', 'cleanup_object_remove_failed', { requestId: ctx.requestId });
      }
    }
    const res = await db.rpc<{ deleted: number; rate_limit_rows_pruned: number }>('delete_upload_sessions', { ids: deletable });
    return { removedObjects, deletedSessions: res.deleted, rateLimitRowsPruned: res.rate_limit_rows_pruned };
  });
}
