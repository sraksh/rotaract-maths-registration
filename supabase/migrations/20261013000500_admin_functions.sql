-- =============================================================================
-- Migration 5: administrator operations
--
-- These functions are executable only by service_role. The Edge Function
-- verifies the caller's JWT and admin_users membership BEFORE calling them and
-- passes the verified actor in the payload; they are never callable from the
-- browser directly.
-- =============================================================================

create or replace function public._like_escape(s text) returns text
language sql immutable set search_path = '' as $$
  select replace(replace(replace(s, chr(92), chr(92) || chr(92)), '%', chr(92) || '%'), '_', chr(92) || '_');
$$;

-- Shared filter used by the table, the export and the reports so they always agree.
-- p = {q, class_level, school, status, from (YYYY-MM-DD, IST), to (YYYY-MM-DD, IST)}
create or replace function public._registration_filter(p jsonb) returns setof public.registrations
language plpgsql stable security definer set search_path = '' as $$
declare
  q      text := nullif(btrim(coalesce(p->>'q', '')), '');
  digits text := regexp_replace(coalesce(p->>'q', ''), '[^0-9]', '', 'g');
begin
  return query
  select r.*
    from public.registrations r
   where (q is null
          or r.registration_id ilike '%' || public._like_escape(q) || '%'
          or r.full_name       ilike '%' || public._like_escape(q) || '%'
          or r.school_name     ilike '%' || public._like_escape(q) || '%'
          or (length(digits) >= 3 and r.mobile like '%' || digits || '%'))
     and (nullif(p->>'class_level', '') is null or r.class_level = (p->>'class_level')::smallint)
     and (nullif(btrim(coalesce(p->>'school', '')), '') is null
          or r.school_key = lower(regexp_replace(btrim(p->>'school'), '\s+', ' ', 'g')))
     and (nullif(p->>'status', '') is null or r.payment_status = p->>'status')
     and (nullif(p->>'from', '') is null
          or r.created_at >= ((p->>'from')::date)::timestamp at time zone 'Asia/Kolkata')
     and (nullif(p->>'to', '') is null
          or r.created_at < (((p->>'to')::date) + 1)::timestamp at time zone 'Asia/Kolkata');
end $$;

-- Full detail + audit history for one registration (admin-only fields included).
create or replace function public._registration_detail(rid text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.registrations;
  hist jsonb;
begin
  select * into r from public.registrations where registration_id = rid;
  if not found then return null; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id,
           'createdAt', a.created_at,
           'action', a.action,
           'actorEmail', a.actor_email,
           'previousStatus', a.previous_status,
           'newStatus', a.new_status,
           'reason', a.reason,
           'note', a.note) order by a.created_at desc, a.id desc), '[]'::jsonb)
    into hist
    from public.audit_log a
   where a.registration_id = r.registration_id;

  return jsonb_build_object(
    'registrationId', r.registration_id,
    'fullName', r.full_name,
    'schoolName', r.school_name,
    'rollNumber', r.roll_number,
    'mobile', r.mobile,
    'classLevel', r.class_level,
    'shift', r.shift,
    'examDate', r.exam_date,
    'examStart', to_char(r.exam_start, 'HH24:MI'),
    'examEnd', to_char(r.exam_end, 'HH24:MI'),
    'reportingTime', to_char(r.reporting_time, 'HH24:MI'),
    'hasProof', r.proof_path is not null,
    'proofContentType', r.proof_content_type,
    'proofSizeBytes', r.proof_size_bytes,
    'paymentStatus', r.payment_status,
    'paymentNote', r.payment_note,
    'paymentRejectReason', r.payment_reject_reason,
    'paymentReviewedAt', r.payment_reviewed_at,
    'paymentReviewedByEmail', r.payment_reviewed_by_email,
    'declarationAccepted', r.declaration_accepted,
    'declarationAcceptedAt', r.declaration_accepted_at,
    'createdAt', r.created_at,
    'updatedAt', r.updated_at,
    'history', hist);
end $$;

-- Dashboard counters, all computed from persisted rows.
-- p = {stale_hours?}  "needs attention" = rejected OR pending for longer than stale_hours.
create or replace function public.admin_stats(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  stale int := coalesce((p->>'stale_hours')::int, 48);
  out jsonb;
begin
  select jsonb_build_object(
    'total', count(*),
    'pending', count(*) filter (where payment_status = 'pending'),
    'verified', count(*) filter (where payment_status = 'verified'),
    'rejected', count(*) filter (where payment_status = 'rejected'),
    'stalePending', count(*) filter (where payment_status = 'pending'
                                       and created_at < now() - make_interval(hours => stale)),
    'attention', count(*) filter (where payment_status = 'rejected'
                                     or (payment_status = 'pending'
                                         and created_at < now() - make_interval(hours => stale))),
    'staleHours', stale)
    into out
    from public.registrations;

  out := out || jsonb_build_object(
    'byClass', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'classLevel', s.class_level, 'shift', s.shift, 'count', coalesce(c.n, 0))
               order by s.class_level), '[]'::jsonb)
        from public.exam_schedules s
        left join (select class_level, count(*) as n from public.registrations group by class_level) c
               on c.class_level = s.class_level),
    'bySchool', (
      select coalesce(jsonb_agg(jsonb_build_object('school', t.school, 'count', t.n)
               order by t.n desc, t.school), '[]'::jsonb)
        from (select min(school_name) as school, count(*) as n
                from public.registrations group by school_key) t),
    'generatedAt', now());
  return out;
end $$;

-- Paginated table. p = filter keys + {page, page_size}
create or replace function public.admin_list_registrations(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  pg   int := greatest(coalesce((p->>'page')::int, 1), 1);
  sz   int := least(greatest(coalesce((p->>'page_size')::int, 25), 1), 100);
  total bigint;
  rows jsonb;
begin
  select count(*) into total from public._registration_filter(p);

  select coalesce(jsonb_agg(jsonb_build_object(
           'registrationId', x.registration_id,
           'fullName', x.full_name,
           'schoolName', x.school_name,
           'rollNumber', x.roll_number,
           'mobile', x.mobile,
           'classLevel', x.class_level,
           'shift', x.shift,
           'examStart', to_char(x.exam_start, 'HH24:MI'),
           'examEnd', to_char(x.exam_end, 'HH24:MI'),
           'reportingTime', to_char(x.reporting_time, 'HH24:MI'),
           'createdAt', x.created_at,
           'paymentStatus', x.payment_status,
           'hasProof', x.proof_path is not null) order by x.created_at desc, x.id desc), '[]'::jsonb)
    into rows
    from (select * from public._registration_filter(p)
           order by created_at desc, id desc
           limit sz offset (pg - 1) * sz) x;

  return jsonb_build_object('rows', rows, 'total', total, 'page', pg, 'pageSize', sz);
end $$;

create or replace function public.admin_get_registration(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  d jsonb := public._registration_detail(p->>'registration_id');
begin
  if d is null then return jsonb_build_object('found', false); end if;
  return jsonb_build_object('found', true, 'registration', d);
end $$;

-- Returns the private storage key so the Edge Function can mint a short-lived URL.
-- Every access is audited. p = {registration_id, actor_id, actor_email}
create or replace function public.admin_get_proof_path(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.registrations;
begin
  select * into r from public.registrations where registration_id = p->>'registration_id';
  if not found then return jsonb_build_object('found', false); end if;
  insert into public.audit_log (actor_id, actor_email, action, registration_id)
  values ((p->>'actor_id')::uuid, p->>'actor_email', 'proof_viewed', r.registration_id);
  return jsonb_build_object('found', true, 'proof_path', r.proof_path, 'content_type', r.proof_content_type);
end $$;

-- Verify / reject a payment with optimistic concurrency.
-- p = {registration_id, expected_status, new_status, reason?, note?, actor_id, actor_email}
create or replace function public.admin_set_payment_status(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.registrations;
  v_new    text := p->>'new_status';
  v_exp    text := p->>'expected_status';
  v_reason text := nullif(btrim(coalesce(p->>'reason', '')), '');
  v_note   text := case when p ? 'note' then nullif(btrim(coalesce(p->>'note', '')), '') else null end;
  v_actor  uuid := (p->>'actor_id')::uuid;
  v_email  text := p->>'actor_email';
begin
  if v_actor is null then raise exception 'actor required'; end if;
  if v_new not in ('verified', 'rejected') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED',
      'fields', jsonb_build_object('newStatus', 'Status must be verified or rejected.'));
  end if;
  if v_new = 'rejected' and (v_reason is null or char_length(v_reason) < 3) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED',
      'fields', jsonb_build_object('reason', 'A reason of at least 3 characters is required to reject a payment proof.'));
  end if;
  if v_reason is not null and char_length(v_reason) > 500 then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED',
      'fields', jsonb_build_object('reason', 'The reason must be 500 characters or fewer.'));
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED',
      'fields', jsonb_build_object('note', 'The note must be 1000 characters or fewer.'));
  end if;

  select * into r from public.registrations where registration_id = p->>'registration_id' for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;

  if r.payment_status <> v_exp then
    return jsonb_build_object('ok', false, 'code', 'STATUS_CONFLICT', 'current_status', r.payment_status,
                              'registration', public._registration_detail(r.registration_id));
  end if;
  if r.payment_status = v_new then
    return jsonb_build_object('ok', false, 'code', 'NO_CHANGE');
  end if;

  update public.registrations
     set payment_status = v_new,
         payment_reject_reason = case when v_new = 'rejected' then v_reason else null end,
         payment_note = case when p ? 'note' then v_note else payment_note end,
         payment_reviewed_at = now(),
         payment_reviewed_by = v_actor,
         payment_reviewed_by_email = v_email
   where id = r.id;

  insert into public.audit_log (actor_id, actor_email, action, registration_id, previous_status, new_status, reason, note)
  values (v_actor, v_email, 'payment_status_changed', r.registration_id, r.payment_status, v_new, v_reason, v_note);

  return jsonb_build_object('ok', true, 'registration', public._registration_detail(r.registration_id));
end $$;

-- Record/replace the internal verification note without changing the status.
-- p = {registration_id, note, actor_id, actor_email}
create or replace function public.admin_update_note(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.registrations;
  v_note text := nullif(btrim(coalesce(p->>'note', '')), '');
begin
  if (p->>'actor_id') is null then raise exception 'actor required'; end if;
  if v_note is not null and char_length(v_note) > 1000 then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED',
      'fields', jsonb_build_object('note', 'The note must be 1000 characters or fewer.'));
  end if;
  select * into r from public.registrations where registration_id = p->>'registration_id' for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;

  update public.registrations set payment_note = v_note where id = r.id;
  insert into public.audit_log (actor_id, actor_email, action, registration_id, note)
  values ((p->>'actor_id')::uuid, p->>'actor_email', 'note_updated', r.registration_id, v_note);
  return jsonb_build_object('ok', true, 'registration', public._registration_detail(r.registration_id));
end $$;

-- Full configuration for the settings screen.
create or replace function public.admin_get_config(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c public.event_config;
begin
  select * into c from public.event_config where id = 1;
  return jsonb_build_object(
    'eventName', c.event_name,
    'organiser', c.organiser,
    'eventDate', c.event_date,
    'venue', c.venue,
    'venueConfirmed', c.venue_confirmed,
    'registrationOpen', c.registration_open,
    'feeAmount', c.fee_amount,
    'upiPayeeName', c.upi_payee_name,
    'upiId', c.upi_id,
    'qrImagePath', c.qr_image_path,
    'updatedAt', c.updated_at,
    'missing', to_jsonb(public.config_missing_items()),
    'schools', (select coalesce(jsonb_agg(sc.name order by sc.name), '[]'::jsonb) from public.schools sc where sc.active),
    'schedules', (select coalesce(jsonb_agg(jsonb_build_object(
                    'classLevel', s.class_level, 'shift', s.shift,
                    'examStart', to_char(s.exam_start, 'HH24:MI'),
                    'examEnd', to_char(s.exam_end, 'HH24:MI'),
                    'reportingTime', to_char(s.reporting_time, 'HH24:MI')) order by s.class_level), '[]'::jsonb)
                    from public.exam_schedules s));
end $$;

-- Patch-style update: only keys present in p are applied.
-- p = {actor_id, actor_email, event_name?, organiser?, event_date?, venue?, venue_confirmed?,
--      registration_open?, fee_amount?, upi_payee_name?, upi_id?, schools?: text[],
--      schedules?: [{classLevel, shift, examStart, examEnd, reportingTime}]}
-- Raises app_error:NOT_READY if the result would be "open" without complete payment details.
create or replace function public.admin_update_config(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  old_c public.event_config;
  new_c public.event_config;
  v_actor uuid := (p->>'actor_id')::uuid;
  changed jsonb := '{}'::jsonb;
  missing text[];
  resynced int := 0;
  n int;
  item jsonb;
begin
  if v_actor is null then raise exception 'actor required'; end if;
  select * into old_c from public.event_config where id = 1 for update;
  new_c := old_c;

  if p ? 'event_name'        then new_c.event_name := btrim(p->>'event_name'); end if;
  if p ? 'organiser'         then new_c.organiser := btrim(p->>'organiser'); end if;
  if p ? 'event_date'        then new_c.event_date := (p->>'event_date')::date; end if;
  if p ? 'venue'             then new_c.venue := nullif(btrim(coalesce(p->>'venue', '')), ''); end if;
  if p ? 'venue_confirmed'   then new_c.venue_confirmed := (p->>'venue_confirmed')::boolean; end if;
  if p ? 'registration_open' then new_c.registration_open := (p->>'registration_open')::boolean; end if;
  if p ? 'fee_amount'        then new_c.fee_amount := nullif(p->>'fee_amount', '')::numeric; end if;
  if p ? 'upi_payee_name'    then new_c.upi_payee_name := nullif(btrim(coalesce(p->>'upi_payee_name', '')), ''); end if;
  if p ? 'upi_id'            then new_c.upi_id := nullif(btrim(coalesce(p->>'upi_id', '')), ''); end if;

  update public.event_config set
    event_name = new_c.event_name, organiser = new_c.organiser, event_date = new_c.event_date,
    venue = new_c.venue, venue_confirmed = new_c.venue_confirmed,
    registration_open = new_c.registration_open, fee_amount = new_c.fee_amount,
    upi_payee_name = new_c.upi_payee_name, upi_id = new_c.upi_id, updated_by = v_actor
  where id = 1;

  -- Record before/after for each scalar setting that actually changed.
  if old_c.event_name        is distinct from new_c.event_name        then changed := changed || jsonb_build_object('event_name', jsonb_build_array(old_c.event_name, new_c.event_name)); end if;
  if old_c.organiser         is distinct from new_c.organiser         then changed := changed || jsonb_build_object('organiser', jsonb_build_array(old_c.organiser, new_c.organiser)); end if;
  if old_c.event_date        is distinct from new_c.event_date        then changed := changed || jsonb_build_object('event_date', jsonb_build_array(old_c.event_date, new_c.event_date)); end if;
  if old_c.venue             is distinct from new_c.venue             then changed := changed || jsonb_build_object('venue', jsonb_build_array(old_c.venue, new_c.venue)); end if;
  if old_c.venue_confirmed   is distinct from new_c.venue_confirmed   then changed := changed || jsonb_build_object('venue_confirmed', jsonb_build_array(old_c.venue_confirmed, new_c.venue_confirmed)); end if;
  if old_c.registration_open is distinct from new_c.registration_open then changed := changed || jsonb_build_object('registration_open', jsonb_build_array(old_c.registration_open, new_c.registration_open)); end if;
  if old_c.fee_amount        is distinct from new_c.fee_amount        then changed := changed || jsonb_build_object('fee_amount', jsonb_build_array(old_c.fee_amount, new_c.fee_amount)); end if;
  if old_c.upi_payee_name    is distinct from new_c.upi_payee_name    then changed := changed || jsonb_build_object('upi_payee_name', jsonb_build_array(old_c.upi_payee_name, new_c.upi_payee_name)); end if;
  if old_c.upi_id            is distinct from new_c.upi_id            then changed := changed || jsonb_build_object('upi_id', jsonb_build_array(old_c.upi_id, new_c.upi_id)); end if;

  if p ? 'schools' then
    insert into public.schools (name)
    select distinct on (k) cleaned
      from (select btrim(regexp_replace(n_, '\s+', ' ', 'g')) as cleaned,
                   lower(btrim(regexp_replace(n_, '\s+', ' ', 'g'))) as k
              from jsonb_array_elements_text(p->'schools') as n_) t
     where cleaned <> ''
     order by k
    on conflict (name_key) do update set name = excluded.name, active = true;

    update public.schools set active = false
     where name_key not in (select lower(btrim(regexp_replace(n_, '\s+', ' ', 'g')))
                              from jsonb_array_elements_text(p->'schools') as n_);
    changed := changed || jsonb_build_object('schools', jsonb_array_length(p->'schools'));
  end if;

  if p ? 'schedules' then
    for item in select * from jsonb_array_elements(p->'schedules') loop
      update public.exam_schedules set
        shift = (item->>'shift')::smallint,
        exam_start = (item->>'examStart')::time,
        exam_end = (item->>'examEnd')::time,
        reporting_time = (item->>'reportingTime')::time,
        updated_by = v_actor
      where class_level = (item->>'classLevel')::smallint;
    end loop;
    changed := changed || jsonb_build_object('schedules', true);
  end if;

  -- Keep every stored registration consistent with the single source of truth.
  update public.registrations r
     set shift = s.shift, exam_start = s.exam_start, exam_end = s.exam_end, reporting_time = s.reporting_time
    from public.exam_schedules s
   where s.class_level = r.class_level
     and (r.shift, r.exam_start, r.exam_end, r.reporting_time)
         is distinct from (s.shift, s.exam_start, s.exam_end, s.reporting_time);
  get diagnostics n = row_count;
  resynced := resynced + n;

  update public.registrations set exam_date = new_c.event_date where exam_date is distinct from new_c.event_date;
  get diagnostics n = row_count;
  resynced := resynced + n;

  missing := public.config_missing_items();
  if new_c.registration_open and cardinality(missing) > 0 then
    raise exception 'app_error:NOT_READY:%', array_to_string(missing, ',');
  end if;

  if changed <> '{}'::jsonb then
    insert into public.audit_log (actor_id, actor_email, action, metadata)
    values (v_actor, p->>'actor_email', 'config_updated',
            jsonb_build_object('changed', changed, 'registrations_resynced', resynced));
  end if;

  return jsonb_build_object('ok', true, 'registrationsResynced', resynced);
end $$;

-- Replace the QR image reference; returns the previous path so it can be deleted.
-- p = {path, actor_id, actor_email}
create or replace function public.admin_set_qr_path(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  prev text;
begin
  if (p->>'actor_id') is null then raise exception 'actor required'; end if;
  select qr_image_path into prev from public.event_config where id = 1 for update;
  update public.event_config set qr_image_path = p->>'path', updated_by = (p->>'actor_id')::uuid where id = 1;
  insert into public.audit_log (actor_id, actor_email, action, metadata)
  values ((p->>'actor_id')::uuid, p->>'actor_email', 'qr_updated', jsonb_build_object('replaced', prev is not null));
  return jsonb_build_object('ok', true, 'previous_path', prev);
end $$;

-- Rows for CSV / Excel / reports, honouring the same filters as the table.
-- Internal notes are returned ONLY when p.include_notes is true.
-- p = filter keys + {include_notes?, format?, actor_id, actor_email}
create or replace function public.admin_export_rows(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  max_rows constant int := 20000;
  incl boolean := coalesce((p->>'include_notes')::boolean, false);
  total bigint;
  rows jsonb;
begin
  if (p->>'actor_id') is null then raise exception 'actor required'; end if;
  select count(*) into total from public._registration_filter(p);

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'registrationId', x.registration_id,
             'fullName', x.full_name,
             'schoolName', x.school_name,
             'rollNumber', x.roll_number,
             'mobile', x.mobile,
             'classLevel', x.class_level,
             'shift', x.shift,
             'examDate', x.exam_date,
             'examStart', to_char(x.exam_start, 'HH24:MI'),
             'examEnd', to_char(x.exam_end, 'HH24:MI'),
             'reportingTime', to_char(x.reporting_time, 'HH24:MI'),
             'createdAt', x.created_at,
             'paymentStatus', x.payment_status)
           || case when incl then jsonb_build_object('paymentNote', x.payment_note,
                                                      'paymentRejectReason', x.payment_reject_reason)
                   else '{}'::jsonb end
           order by x.created_at desc, x.id desc), '[]'::jsonb)
    into rows
    from (select * from public._registration_filter(p) order by created_at desc, id desc limit max_rows) x;

  insert into public.audit_log (actor_id, actor_email, action, metadata)
  values ((p->>'actor_id')::uuid, p->>'actor_email', 'export',
          jsonb_build_object('format', coalesce(p->>'format', 'unknown'), 'row_count', least(total, max_rows),
                             'include_notes', incl,
                             'filters', (p - 'actor_id' - 'actor_email' - 'include_notes' - 'format')));

  return jsonb_build_object('rows', rows, 'total', total, 'truncated', total > max_rows);
end $$;

-- ---------------------------------------------------------------- cleanup ----

-- Sessions that were never finalised and are well past expiry. p = {grace_seconds?, limit?}
create or replace function public.claim_expired_upload_sessions(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  grace int := coalesce((p->>'grace_seconds')::int, 3600);
  lim   int := least(coalesce((p->>'limit')::int, 200), 1000);
  out   jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'proof_path', t.proof_path)), '[]'::jsonb)
    into out
    from (select id, proof_path
            from public.upload_sessions
           where status <> 'consumed' and expires_at < now() - make_interval(secs => grace)
           order by expires_at
           limit lim
             for update skip locked) t;
  return out;
end $$;

-- p = {ids: [uuid]}. Also prunes old rate-limit windows.
create or replace function public.delete_upload_sessions(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n int;
  pruned int;
begin
  delete from public.upload_sessions
   where status <> 'consumed'
     and id in (select (v)::uuid from jsonb_array_elements_text(coalesce(p->'ids', '[]'::jsonb)) as v);
  get diagnostics n = row_count;
  delete from public.rate_limits where window_start < now() - interval '1 day';
  get diagnostics pruned = row_count;
  return jsonb_build_object('deleted', n, 'rate_limit_rows_pruned', pruned);
end $$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public._like_escape(text)',
    'public._registration_filter(jsonb)',
    'public._registration_detail(text)',
    'public.admin_stats(jsonb)',
    'public.admin_list_registrations(jsonb)',
    'public.admin_get_registration(jsonb)',
    'public.admin_get_proof_path(jsonb)',
    'public.admin_set_payment_status(jsonb)',
    'public.admin_update_note(jsonb)',
    'public.admin_get_config(jsonb)',
    'public.admin_update_config(jsonb)',
    'public.admin_set_qr_path(jsonb)',
    'public.admin_export_rows(jsonb)',
    'public.claim_expired_upload_sessions(jsonb)',
    'public.delete_upload_sessions(jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
