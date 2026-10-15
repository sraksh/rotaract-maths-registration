-- =============================================================================
-- 34th Padmabai Rungta Inter-District Mathematics Competition 2026
-- Migration 1: core schema
--
-- All tables live in the `public` schema but are NOT directly reachable from the
-- browser: migration 2 enables RLS, adds no policies for anon/authenticated and
-- revokes their table privileges. Every read/write goes through the
-- service-role-only functions defined in migrations 3-5, called by Edge Functions.
-- =============================================================================

-- ---------------------------------------------------------------- helpers ----

create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ----------------------------------------------------------- event_config ----
-- Singleton row (id = 1). Fee / UPI / QR are deliberately NULL until the
-- organisers configure them: nothing is invented.

create table public.event_config (
  id                smallint primary key default 1 check (id = 1),
  event_name        text not null check (char_length(btrim(event_name)) between 3 and 200),
  organiser         text not null check (char_length(btrim(organiser)) between 2 and 200),
  event_date        date not null,
  venue             text check (venue is null or char_length(btrim(venue)) between 2 and 300),
  venue_confirmed   boolean not null default false,
  registration_open boolean not null default false,
  fee_amount        numeric(10,2) check (fee_amount is null or fee_amount > 0),
  upi_payee_name    text check (upi_payee_name is null or char_length(btrim(upi_payee_name)) between 2 and 120),
  upi_id            text check (upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,100}@[A-Za-z][A-Za-z0-9]{1,63}$'),
  qr_image_path     text check (qr_image_path is null or char_length(qr_image_path) between 3 and 300),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  updated_by        uuid
);

create trigger event_config_updated_at before update on public.event_config
  for each row execute function public.set_updated_at();

insert into public.event_config (id, event_name, organiser, event_date, venue, venue_confirmed, registration_open)
values (
  1,
  '34th Padmabai Rungta Inter-District Mathematics Competition 2026',
  'Rotaract Club of Chaibasa',
  date '2026-11-22',
  'Narbheram Hansraj English School, Jamshedpur',
  false,   -- tentative until the organisers confirm the examination centre
  false    -- registration stays closed until an admin opens it
);

-- ---------------------------------------------------------------- schools ----

create table public.schools (
  id         bigint generated always as identity primary key,
  name       text not null check (char_length(name) between 2 and 150 and name = btrim(name)),
  name_key   text generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index schools_name_key_uq on public.schools (name_key);

-- --------------------------------------------------------- exam_schedules ----
-- One row per class. The class determines the shift; the browser never supplies
-- trusted times. Defaults mirror DEFAULT_SCHEDULES in
-- supabase/functions/_shared/schedule.ts (a test keeps them identical).

create table public.exam_schedules (
  class_level    smallint primary key check (class_level between 7 and 10),
  shift          smallint not null check (shift in (1, 2)),
  exam_start     time not null,
  exam_end       time not null,
  reporting_time time not null,
  updated_at     timestamptz not null default now(),
  updated_by     uuid,
  check (exam_start < exam_end),
  check (reporting_time <= exam_start)
);

create trigger exam_schedules_updated_at before update on public.exam_schedules
  for each row execute function public.set_updated_at();

insert into public.exam_schedules (class_level, shift, exam_start, exam_end, reporting_time) values
  (7,  1, time '10:00', time '12:00', time '09:30'),
  (8,  2, time '13:30', time '15:30', time '13:00'),
  (9,  1, time '10:00', time '12:00', time '09:30'),
  (10, 2, time '13:30', time '15:30', time '13:00');

-- ---------------------------------------------------------- registrations ----

create table public.registrations (
  id                        uuid primary key default gen_random_uuid(),
  registration_id           text not null unique check (registration_id ~ '^PRM34-[0-9A-F]{10}$'),
  idempotency_key           uuid not null unique,
  request_hash              text not null,

  full_name                 text not null check (char_length(full_name) between 2 and 100 and full_name = btrim(full_name)),
  school_name               text not null check (char_length(school_name) between 2 and 150 and school_name = btrim(school_name)),
  school_key                text generated always as (lower(regexp_replace(btrim(school_name), '\s+', ' ', 'g'))) stored,
  roll_number               text not null check (char_length(roll_number) between 1 and 20 and roll_number = btrim(roll_number)),
  mobile                    text not null check (mobile ~ '^\+91[6-9][0-9]{9}$'),

  class_level               smallint not null check (class_level between 7 and 10),
  shift                     smallint not null check (shift in (1, 2)),
  exam_date                 date not null,
  exam_start                time not null,
  exam_end                  time not null,
  reporting_time            time not null,

  proof_path                text not null unique,
  proof_content_type        text not null check (proof_content_type in ('image/jpeg', 'image/png', 'image/webp')),
  proof_size_bytes          integer not null check (proof_size_bytes between 1 and 5242880),

  payment_status            text not null default 'pending' check (payment_status in ('pending', 'verified', 'rejected')),
  payment_note              text check (payment_note is null or char_length(payment_note) <= 1000),
  payment_reject_reason     text check (payment_reject_reason is null or char_length(payment_reject_reason) <= 500),
  payment_reviewed_at       timestamptz,
  payment_reviewed_by       uuid,
  payment_reviewed_by_email text,

  declaration_accepted      boolean not null check (declaration_accepted),
  declaration_accepted_at   timestamptz not null,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  check (exam_start < exam_end),
  check (reporting_time <= exam_start),
  check (payment_status <> 'rejected' or nullif(btrim(coalesce(payment_reject_reason, '')), '') is not null)
);

-- NOTE: no unique constraint on roll_number or mobile — see specification.
create index registrations_school_idx     on public.registrations (school_key);
create index registrations_class_idx      on public.registrations (class_level);
create index registrations_created_idx    on public.registrations (created_at desc);
create index registrations_status_idx     on public.registrations (payment_status);
create index registrations_mobile_idx     on public.registrations (mobile);

create trigger registrations_updated_at before update on public.registrations
  for each row execute function public.set_updated_at();

-- --------------------------------------------------------- upload_sessions ----
-- Binds one private storage object to one idempotency key, so a registration can
-- only ever be finalised with the upload that was issued for that submission.

create table public.upload_sessions (
  id                       uuid primary key default gen_random_uuid(),
  idempotency_key          uuid not null unique,
  proof_path               text not null unique,
  status                   text not null default 'issued' check (status in ('issued', 'consumed', 'rejected')),
  ip_hash                  text,
  created_at               timestamptz not null default now(),
  expires_at               timestamptz not null,
  consumed_registration_id uuid references public.registrations (id)
);

create index upload_sessions_cleanup_idx on public.upload_sessions (expires_at) where status <> 'consumed';

-- -------------------------------------------------------------- audit_log ----
-- Append-only: triggers reject UPDATE/DELETE/TRUNCATE, and migration 2 also
-- removes those privileges from service_role.

create table public.audit_log (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  actor_id        uuid,
  actor_email     text,
  action          text not null check (char_length(action) between 1 and 60),
  registration_id text,
  previous_status text,
  new_status      text,
  reason          text,
  note            text,
  metadata        jsonb not null default '{}'::jsonb
);

create index audit_log_registration_idx on public.audit_log (registration_id, created_at desc);
create index audit_log_action_idx       on public.audit_log (action, created_at desc);

create or replace function public.audit_log_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_log is append-only' using errcode = 'insufficient_privilege';
end $$;

create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function public.audit_log_immutable();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function public.audit_log_immutable();

-- ------------------------------------------------------------ admin_users ----
-- Authorisation list. Rows are created ONLY by an operator (SQL editor / CLI),
-- never by the public app. See README "Provision administrators".

create table public.admin_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  role       text not null default 'admin' check (role in ('admin')),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  created_by text
);

-- ------------------------------------------------------------ rate_limits ----

create table public.rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (bucket, window_start)
);
