-- Allow /student (anon) to resolve organization names on feed posts.
-- 20260528600000 already creates this policy for anon and authenticated.
drop policy if exists organizations_select_public on public.organizations;
create policy organizations_select_public on public.organizations
  for select using (true);

-- Allow submitters to update a post (e.g. attach image path after upload)
create policy student_feed_posts_update_own on public.student_feed_posts
  for update to authenticated
  using (submitted_by = auth.uid())
  with check (submitted_by = auth.uid());
