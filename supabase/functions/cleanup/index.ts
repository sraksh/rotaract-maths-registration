// Scheduled maintenance endpoint (see ../_shared/cleanup.ts). Protected by x-cleanup-secret.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createSupabaseDeps, loadHandlerConfig } from '../_shared/adapter.ts';
import { createCleanupHandler } from '../_shared/cleanup.ts';

const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(createCleanupHandler(createSupabaseDeps(client, loadHandlerConfig((k) => Deno.env.get(k)))));
