/**
 * Public, build-time configuration. Only the PUBLISHABLE key may ever appear here —
 * these values are embedded in the static site and visible to everyone.
 */
const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? '';
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)?.trim() ?? '';

const PLACEHOLDER = /your-project-ref|your-publishable-key/i;

export const SUPABASE_URL = url.replace(/\/+$/, '');
export const SUPABASE_PUBLISHABLE_KEY = key;

/** True only when real (non-placeholder) values were supplied at build time. */
export const backendConfigured =
  /^https?:\/\//.test(url) && key !== '' && !PLACEHOLDER.test(url) && !PLACEHOLDER.test(key);

/** Guard against the most dangerous mistake: a service-role key in a public build. */
export function looksLikeSecretKey(k: string): boolean {
  if (k.startsWith('sb_secret_')) return true;
  try {
    const part = k.split('.')[1];
    if (!part) return false;
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { role?: string };
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

export const secretKeyDetected = looksLikeSecretKey(key);
