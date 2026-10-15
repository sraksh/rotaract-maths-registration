-- =============================================================================
-- Migration 4: registration workflow (upload sessions, idempotent creation)
-- =============================================================================

-- Server-side registration ID, e.g. PRM34-3F9A07C1D2. Uniqueness is enforced by a
-- UNIQUE constraint; create_registration() retries on collision. Kept as its own
-- function so the collision path can be exercised in tests.
create or replace function public.generate_registration_id() returns text
language sql volatile set search_path = '' as $$
  select 'PRM34-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
$$;

-- The minimal data shown on the confirmation screen.
create or replace function public._registration_receipt(r public.registrations) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'registrationId', r.registration_id,
    'fullName', r.full_name,
    'schoolName', r.school_name,
    'classLevel', r.class_level,
    'shift', r.shift,
    'examDate', r.exam_date,
    'examStart', to_char(r.exam_start, 'HH24:MI'),
    'examEnd', to_char(r.exam_end, 'HH24:MI'),
    'reportingTime', to_char(r.reporting_time, 'HH24:MI'),
    'paymentStatus', r.payment_status,
    'createdAt', r.created_at);
$$;

-- Issue (or re-issue) the single upload slot bound to an idempotency key.
-- p = {idempotency_key, proof_path, ip_hash, ttl_seconds}
create or replace function public.create_upload_session(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_key uuid := (p->>'idempotency_key')::uuid;
  reg public.registrations;
  cfg public.event_config;
  s   public.upload_sessions;
begin
  -- A retry after a successful save needs no new upload.
  select * into reg from public.registrations where idempotency_key = v_key;
  if found then
    return jsonb_build_object('ok', true, 'replay', true, 'registration', public._registration_receipt(reg));
  end if;

  select * into cfg from public.event_config where id = 1;
  if not found or not cfg.registration_open then
    return jsonb_build_object('ok', false, 'code', 'REGISTRATION_CLOSED');
  end if;
  if cardinality(public.config_missing_items()) > 0 then
    return jsonb_build_object('ok', false, 'code', 'NOT_CONFIGURED');
  end if;

  insert into public.upload_sessions as u (idempotency_key, proof_path, ip_hash, expires_at)
  values (
    v_key,
    p->>'proof_path',
    p->>'ip_hash',
    now() + make_interval(secs => coalesce((p->>'ttl_seconds')::int, 3600)))
  on conflict (idempotency_key) do update
    set status = 'issued', expires_at = excluded.expires_at, ip_hash = excluded.ip_hash
    where u.status in ('issued', 'rejected')
  returning * into s;

  if not found then
    -- The session was consumed concurrently: the registration now exists.
    select * into reg from public.registrations where idempotency_key = v_key;
    if found then
      return jsonb_build_object('ok', true, 'replay', true, 'registration', public._registration_receipt(reg));
    end if;
    return jsonb_build_object('ok', false, 'code', 'UPLOAD_SESSION_INVALID');
  end if;

  return jsonb_build_object(
    'ok', true, 'replay', false,
    'session_id', s.id, 'proof_path', s.proof_path, 'expires_at', s.expires_at);
end $$;

-- Look up an upload session so the Edge Function can verify the stored object.
-- p = {idempotency_key, session_id}
create or replace function public.get_upload_session(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.upload_sessions;
begin
  select * into s from public.upload_sessions
   where id = (p->>'session_id')::uuid and idempotency_key = (p->>'idempotency_key')::uuid;
  if not found then return jsonb_build_object('found', false); end if;
  return jsonb_build_object(
    'found', true,
    'status', s.status,
    'proof_path', s.proof_path,
    'expired', s.expires_at < now());
end $$;

-- The stored object failed verification; allow the user to upload again.
create or replace function public.mark_upload_rejected(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  update public.upload_sessions set status = 'rejected'
   where id = (p->>'session_id')::uuid and status = 'issued';
  return jsonb_build_object('ok', true);
end $$;

-- Atomically create a registration.
--   * idempotent: the same idempotency_key + request_hash returns the same row
--   * the browser's schedule data is never trusted: times come from exam_schedules
--   * the upload session must belong to this key and be unexpired and unused
--   * registration IDs are generated here, with collision retries
-- p = {idempotency_key, session_id, request_hash, full_name, school_name,
--      roll_number, mobile, class_level, shift, proof_content_type, proof_size_bytes}
create or replace function public.create_registration(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_key  uuid := (p->>'idempotency_key')::uuid;
  v_sid  uuid := (p->>'session_id')::uuid;
  v_hash text := p->>'request_hash';
  cfg    public.event_config;
  sched  public.exam_schedules;
  sess   public.upload_sessions;
  reg    public.registrations;
  have_session boolean;
  attempts int := 0;
  v_rid  text;
begin
  -- Lock the session first so concurrent retries of one submission serialise here
  -- and the loser then observes the winner's committed registration.
  select * into sess from public.upload_sessions
   where id = v_sid and idempotency_key = v_key for update;
  have_session := found;

  select * into reg from public.registrations where idempotency_key = v_key;
  if found then
    if reg.request_hash <> v_hash then
      return jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_KEY_REUSED');
    end if;
    return jsonb_build_object('ok', true, 'replayed', true, 'registration', public._registration_receipt(reg));
  end if;

  select * into cfg from public.event_config where id = 1;
  if not found or not cfg.registration_open then
    return jsonb_build_object('ok', false, 'code', 'REGISTRATION_CLOSED');
  end if;
  if cardinality(public.config_missing_items()) > 0 then
    return jsonb_build_object('ok', false, 'code', 'NOT_CONFIGURED');
  end if;

  select * into sched from public.exam_schedules where class_level = (p->>'class_level')::smallint;
  if not found or sched.shift <> (p->>'shift')::smallint then
    return jsonb_build_object('ok', false, 'code', 'SCHEDULE_MISMATCH');
  end if;

  if not have_session or sess.status <> 'issued' then
    return jsonb_build_object('ok', false, 'code', 'UPLOAD_SESSION_INVALID');
  end if;
  if sess.expires_at < now() then
    return jsonb_build_object('ok', false, 'code', 'UPLOAD_SESSION_EXPIRED');
  end if;

  loop
    attempts := attempts + 1;
    v_rid := public.generate_registration_id();
    begin
      insert into public.registrations (
        registration_id, idempotency_key, request_hash,
        full_name, school_name, roll_number, mobile,
        class_level, shift, exam_date, exam_start, exam_end, reporting_time,
        proof_path, proof_content_type, proof_size_bytes,
        declaration_accepted, declaration_accepted_at)
      values (
        v_rid, v_key, v_hash,
        p->>'full_name', p->>'school_name', p->>'roll_number', p->>'mobile',
        sched.class_level, sched.shift, cfg.event_date, sched.exam_start, sched.exam_end, sched.reporting_time,
        sess.proof_path, p->>'proof_content_type', (p->>'proof_size_bytes')::int,
        true, now())
      returning * into reg;
      exit;
    exception when unique_violation then
      -- Either a concurrent insert used the same idempotency key, or the generated
      -- registration ID collided. Distinguish the two.
      select * into reg from public.registrations where idempotency_key = v_key;
      if found then
        if reg.request_hash <> v_hash then
          return jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_KEY_REUSED');
        end if;
        return jsonb_build_object('ok', true, 'replayed', true, 'registration', public._registration_receipt(reg));
      end if;
      if attempts >= 10 then
        raise exception 'registration id allocation failed after % attempts', attempts;
      end if;
    end;
  end loop;

  update public.upload_sessions
     set status = 'consumed', consumed_registration_id = reg.id
   where id = sess.id;

  insert into public.audit_log (action, registration_id, new_status, metadata)
  values ('registration_created', reg.registration_id, 'pending', jsonb_build_object('class_level', reg.class_level));

  return jsonb_build_object('ok', true, 'replayed', false, 'registration', public._registration_receipt(reg));
end $$;

revoke all on function public.generate_registration_id() from public, anon, authenticated;
grant execute on function public.generate_registration_id() to service_role;
revoke all on function public._registration_receipt(public.registrations) from public, anon, authenticated;
grant execute on function public._registration_receipt(public.registrations) to service_role;
revoke all on function public.create_upload_session(jsonb) from public, anon, authenticated;
grant execute on function public.create_upload_session(jsonb) to service_role;
revoke all on function public.get_upload_session(jsonb) from public, anon, authenticated;
grant execute on function public.get_upload_session(jsonb) to service_role;
revoke all on function public.mark_upload_rejected(jsonb) from public, anon, authenticated;
grant execute on function public.mark_upload_rejected(jsonb) to service_role;
revoke all on function public.create_registration(jsonb) from public, anon, authenticated;
grant execute on function public.create_registration(jsonb) to service_role;
