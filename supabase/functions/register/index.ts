// Public registration endpoint (see ../_shared/register.ts).
// Deployed with verify_jwt = false (see supabase/config.toml): it is public by design and
// protects itself with strict validation, idempotency, upload verification and rate limits.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createSupabaseDeps, loadHandlerConfig } from '../_shared/adapter.ts';
import { createRegisterHandler } from '../_shared/register.ts';

// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform. The
// service-role key stays inside this server-side function and is never sent to a browser.
const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(createRegisterHandler(createSupabaseDeps(client, loadHandlerConfig((k) => Deno.env.get(k)))));
