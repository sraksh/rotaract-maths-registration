-- =============================================================================
-- Migration 7: student admit card lookup
--
-- A student proves who they are with registration ID + mobile number (both are
-- needed, and the ID is a random 40-bit value). The function returns ONLY what is
-- printed on the admit card, and only when:
--   * the payment has been verified by an administrator, and
--   * the examination centre has been marked final.
-- A wrong ID or mobile number gives the same generic NOT_FOUND answer, so the
-- endpoint cannot be used to check whether a registration exists.
-- Callable only by service_role (the Edge Function adds IP rate limiting).
-- p = {registration_id, mobile (+91XXXXXXXXXX)}
-- =============================================================================
create or replace function public.get_admit_card(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.registrations;
  c public.event_config;
begin
  select * into r from public.registrations
   where registration_id = upper(btrim(coalesce(p->>'registration_id', '')));
  if not found or r.mobile is distinct from (p->>'mobile') then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  select * into c from public.event_config where id = 1;

  if r.payment_status <> 'verified' then
    return jsonb_build_object('ok', false, 'code', 'ADMIT_CARD_NOT_AVAILABLE',
                              'reason', 'payment_' || r.payment_status);
  end if;
  if not c.venue_confirmed or c.venue is null then
    return jsonb_build_object('ok', false, 'code', 'ADMIT_CARD_NOT_AVAILABLE', 'reason', 'centre_unconfirmed');
  end if;

  return jsonb_build_object('ok', true, 'card', jsonb_build_object(
    'registrationId', r.registration_id,
    'fullName', r.full_name,
    'schoolName', r.school_name,
    'rollNumber', r.roll_number,
    'classLevel', r.class_level,
    'shift', r.shift,
    'examDate', r.exam_date,
    'examStart', to_char(r.exam_start, 'HH24:MI'),
    'examEnd', to_char(r.exam_end, 'HH24:MI'),
    'reportingTime', to_char(r.reporting_time, 'HH24:MI'),
    'eventName', c.event_name,
    'organiser', c.organiser,
    'venue', c.venue));
end $$;

revoke all on function public.get_admit_card(jsonb) from public, anon, authenticated;
grant execute on function public.get_admit_card(jsonb) to service_role;
