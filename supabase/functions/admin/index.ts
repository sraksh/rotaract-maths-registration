// Administrator endpoint (see ../_shared/admin.ts).
// Authentication and the admin-role check happen inside the handler on every request.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createAdminHandler } from '../_shared/admin.ts';
import { createSupabaseDeps, loadHandlerConfig } from '../_shared/adapter.ts';

const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(createAdminHandler(createSupabaseDeps(client, loadHandlerConfig((k) => Deno.env.get(k)))));
