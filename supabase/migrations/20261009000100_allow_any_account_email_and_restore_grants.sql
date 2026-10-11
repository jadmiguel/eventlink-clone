-- Accounts can be created with any email address, including ones that are not real inboxes.
update public.app_settings
set require_isu_email = false
where id = 1;

-- This database was missing the normal client grants. RLS still controls which rows
-- each role can see. Re-apply the lockdowns that later migrations intended.
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

revoke all on table public.app_settings from anon;
grant select, update on table public.app_settings to authenticated;

revoke all on table public.event_feedback_legacy_archive from public, anon, authenticated;
revoke all on table public.notification_email_outbox from public, anon, authenticated;
revoke all on table public.event_request_upload_intents from public, anon, authenticated;
revoke all on table public.rate_limit_buckets from public, anon, authenticated;

revoke insert, update, delete on table public.event_venue_reservations from anon, authenticated;
revoke insert, update, delete on table public.event_equipment_reservations from anon, authenticated;
revoke insert, update, delete on table public.event_requests from anon, authenticated;
revoke insert, update, delete on table public.event_request_resource_assignments from anon, authenticated;
revoke insert, update, delete on table public.event_request_equipment from anon, authenticated;
revoke insert, update, delete on table public.event_request_history from anon, authenticated;
revoke insert, update, delete on table public.event_request_letters from anon, authenticated;
revoke insert, update, delete on table public.event_request_compliance_comments from anon, authenticated;
revoke insert, update, delete on table public.event_feedback from anon, authenticated;

revoke select (feedback_access_code_hash) on table public.student_feed_posts from anon, authenticated, public;

revoke select on table public.event_requests from anon;
grant select (
  id,
  activity,
  start_date,
  end_date,
  start_time,
  end_time,
  venue,
  status,
  posted_at,
  calendar_posted_at,
  organization_id,
  request_type
) on table public.event_requests to anon;
