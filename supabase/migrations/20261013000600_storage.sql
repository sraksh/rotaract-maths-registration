-- =============================================================================
-- Migration 6: storage buckets
--
--   payment-proofs  PRIVATE. Student payment screenshots. No storage policies are
--                   created, so anon/authenticated can neither list, read nor write.
--                   Uploads happen only through single-use signed upload URLs minted
--                   by the `register` Edge Function; admins read through 60-second
--                   signed URLs minted by the `admin` Edge Function.
--                   The bucket itself also enforces a 5 MB limit and image MIME types.
--
--   payment-qr      PUBLIC. The organisers' official UPI QR image, which is meant to be
--                   shown to every payer. Only service_role can write to it.
--
-- Guarded so the migration also runs on plain PostgreSQL (used by the test harness).
-- =============================================================================

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not found; skipping bucket creation';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('payment-proofs', 'payment-proofs', false, 5242880,
          array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('payment-qr', 'payment-qr', true, 2097152,
          array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update
    set public = true,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
end $$;
