-- =============================================================================
-- Migration 2: Row Level Security and least-privilege grants
--
-- Model: the browser (roles `anon` / `authenticated`) has NO direct access to any
-- table. RLS is enabled with no policies (deny by default) AND table privileges
-- are revoked, so two independent layers must both fail before data leaks.
-- Edge Functions use `service_role`, which is the only role granted privileges.
-- =============================================================================

alter table public.event_config    enable row level security;
alter table public.schools         enable row level security;
alter table public.exam_schedules  enable row level security;
alter table public.registrations   enable row level security;
alter table public.upload_sessions enable row level security;
alter table public.audit_log       enable row level security;
alter table public.admin_users     enable row level security;
alter table public.rate_limits     enable row level security;

revoke all on table
  public.event_config, public.schools, public.exam_schedules, public.registrations,
  public.upload_sessions, public.audit_log, public.admin_users, public.rate_limits
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.event_config, public.schools, public.exam_schedules, public.registrations,
  public.upload_sessions, public.admin_users, public.rate_limits
to service_role;

-- The audit trail is append-only even for service_role.
revoke all on table public.audit_log from service_role;
grant select, insert on table public.audit_log to service_role;

-- Anything created later in this schema is private by default too.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- Trigger functions are never meant to be called by API roles. Postgres grants EXECUTE to
-- PUBLIC by default; remove it (triggers keep firing: EXECUTE is only checked at CREATE TRIGGER).
revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.audit_log_immutable() from public, anon, authenticated;
