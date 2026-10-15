import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, backendConfigured, secretKeyDetected } from './env';

let client: SupabaseClient | null = null;

/**
 * Single browser client using only the publishable key. The administrator session is
 * kept in sessionStorage (cleared when the tab closes) rather than localStorage.
 */
export function getSupabase(): SupabaseClient {
  if (!backendConfigured || secretKeyDetected) throw new Error('Backend is not configured.');
  client ??= createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: window.sessionStorage,
    },
  });
  return client;
}
