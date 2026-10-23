-- Hardening after the Supabase security advisors ran on the real project.
-- Pins search_path on the two trigger functions, and stops the anon role
-- from calling dashboard_role() (policies only ever evaluate it as
-- authenticated). keepalive() stays callable by anon on purpose: the
-- keep-alive workflow uses the anon key.

alter function keep_one_active_owner() set search_path to 'public';
alter function refuse_audit_change() set search_path to 'public';
revoke execute on function dashboard_role() from anon;
