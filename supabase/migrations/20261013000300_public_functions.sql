-- =============================================================================
-- Migration 3: public configuration, readiness, rate limiting, admin lookup
--
-- Convention: every privileged function takes ONE jsonb argument and returns
-- jsonb. Expected business failures are returned as {"ok": false, "code": ...};
-- failures that must roll back a transaction RAISE with the message
-- 'app_error:<CODE>:<detail>'.
-- Every function is SECURITY DEFINER with an empty search_path and is executable
-- only by service_role, except get_public_config() which anon may call.
-- =============================================================================

-- Which essential settings are still missing? Registration cannot go live (and
-- payment details are never shown) until this list is empty.
create or replace function public.config_missing_items() returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  c public.event_config;
  m text[] := '{}';
begin
  select * into c from public.event_config where id = 1;
  if not found then return array['eventConfig']; end if;
  if c.fee_amount is null then m := m || 'fee'::text; end if;
  if nullif(btrim(coalesce(c.upi_payee_name, '')), '') is null then m := m || 'upiPayeeName'::text; end if;
  if c.upi_id is null then m := m || 'upiId'::text; end if;
  if c.qr_image_path is null then m := m || 'qrImage'::text; end if;
  if (select count(*) from public.exam_schedules) <> 4 then m := m || 'schedules'::text; end if;
  return m;
end $$;

-- Public, read-only settings needed by the registration form. Payment details are
-- only returned when ALL of them are configured; otherwise "payment" is null.
create or replace function public.get_public_config() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c public.event_config;
  missing text[];
  sched jsonb;
  school_list jsonb;
begin
  select * into c from public.event_config where id = 1;
  if not found then
    return jsonb_build_object('registrationOpen', false, 'paymentReady', false, 'missing', jsonb_build_array('eventConfig'));
  end if;
  missing := public.config_missing_items();

  select coalesce(jsonb_agg(jsonb_build_object(
           'classLevel', s.class_level,
           'shift', s.shift,
           'examStart', to_char(s.exam_start, 'HH24:MI'),
           'examEnd', to_char(s.exam_end, 'HH24:MI'),
           'reportingTime', to_char(s.reporting_time, 'HH24:MI')) order by s.class_level), '[]'::jsonb)
    into sched from public.exam_schedules s;

  select coalesce(jsonb_agg(sc.name order by sc.name), '[]'::jsonb)
    into school_list from public.schools sc where sc.active;

  return jsonb_build_object(
    'event', jsonb_build_object(
      'name', c.event_name,
      'organiser', c.organiser,
      'date', c.event_date,
      'venue', c.venue,
      'venueConfirmed', c.venue_confirmed),
    'registrationOpen', c.registration_open,
    'paymentReady', cardinality(missing) = 0,
    'missing', to_jsonb(missing),
    'payment', case when cardinality(missing) = 0 then jsonb_build_object(
        'fee', c.fee_amount,
        'payeeName', c.upi_payee_name,
        'upiId', c.upi_id,
        'qrImagePath', c.qr_image_path) else null end,
    'schools', school_list,
    'schedules', sched,
    'limits', jsonb_build_object('maxProofBytes', 5242880));
end $$;

revoke all on function public.config_missing_items() from public, anon, authenticated;
grant execute on function public.config_missing_items() to service_role;
revoke all on function public.get_public_config() from public;
grant execute on function public.get_public_config() to anon, authenticated, service_role;

-- Fixed-window rate limiter. p = {bucket, limit, window_seconds}
create or replace function public.check_rate_limit(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  b   text := p->>'bucket';
  lim int  := (p->>'limit')::int;
  w   int  := (p->>'window_seconds')::int;
  ws  timestamptz;
  h   int;
begin
  if b is null or lim is null or w is null or w <= 0 then
    raise exception 'invalid rate limit arguments';
  end if;
  ws := to_timestamp(floor(extract(epoch from now()) / w) * w);
  insert into public.rate_limits as rl (bucket, window_start, hits)
  values (b, ws, 1)
  on conflict (bucket, window_start) do update set hits = rl.hits + 1
  returning rl.hits into h;
  return jsonb_build_object(
    'allowed', h <= lim,
    'hits', h,
    'retry_after_seconds', greatest(1, ceil(extract(epoch from (ws + make_interval(secs => w) - now()))))::int);
end $$;

-- Is this authenticated user an active administrator? p = {user_id}
create or replace function public.admin_lookup(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a public.admin_users;
begin
  select * into a from public.admin_users where user_id = (p->>'user_id')::uuid;
  if not found or not a.active then
    return jsonb_build_object('is_admin', false);
  end if;
  return jsonb_build_object('is_admin', true, 'role', a.role, 'email', a.email);
end $$;

revoke all on function public.check_rate_limit(jsonb) from public, anon, authenticated;
grant execute on function public.check_rate_limit(jsonb) to service_role;
revoke all on function public.admin_lookup(jsonb) from public, anon, authenticated;
grant execute on function public.admin_lookup(jsonb) to service_role;
