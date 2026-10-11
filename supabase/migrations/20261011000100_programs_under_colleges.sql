-- College → programs → organizations.
-- One dean stays on the college. Advisers belong to a program.
-- Student officers stay on an organization. Existing organizations keep a
-- null program_id until an admin assigns them. College names are not split.

create table if not exists public.programs (
  id uuid primary key default gen_random_uuid(),
  college_id uuid not null references public.colleges (id) on delete cascade,
  name text not null,
  code text,
  created_at timestamptz not null default now(),
  constraint programs_name_not_blank check (char_length(btrim(name)) > 0)
);

create unique index if not exists programs_college_name_unique
  on public.programs (college_id, lower(btrim(name)));

create unique index if not exists programs_college_code_unique
  on public.programs (college_id, upper(btrim(code)))
  where code is not null and btrim(code) <> '';

create index if not exists programs_college_id_idx on public.programs (college_id);

alter table public.organizations
  add column if not exists program_id uuid references public.programs (id) on delete set null;

create index if not exists organizations_program_id_idx on public.organizations (program_id);

alter table public.profiles
  add column if not exists program_id uuid references public.programs (id) on delete set null;

create index if not exists profiles_program_id_idx on public.profiles (program_id);

create or replace function public.sync_organization_program_college()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_college uuid;
begin
  if new.program_id is null then
    return new;
  end if;
  select p.college_id into v_college
  from public.programs p
  where p.id = new.program_id;
  if v_college is null then
    raise exception 'Program not found.';
  end if;
  new.college_id := v_college;
  return new;
end;
$$;

drop trigger if exists sync_organization_program_college on public.organizations;
create trigger sync_organization_program_college
before insert or update of program_id on public.organizations
for each row execute function public.sync_organization_program_college();

alter table public.programs enable row level security;

drop policy if exists programs_select_public on public.programs;
create policy programs_select_public on public.programs
  for select using (true);

drop policy if exists programs_admin_write on public.programs;
create policy programs_admin_write on public.programs
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

grant select, insert, update, delete on public.programs to anon, authenticated;
grant all on public.programs to service_role;

-- An adviser covers every organization in their program.
-- Accounts created before programs still match their organization.
create or replace function public.adviser_covers_organization(
  p_user_id uuid,
  p_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_organization_id is not null
    and exists (
      select 1
      from public.profiles p
      join public.organizations o on o.id = p_organization_id
      where p.id = p_user_id
        and (
          (p.program_id is not null and o.program_id = p.program_id)
          or (
            p.program_id is null
            and p.organization_id is not null
            and p.organization_id = p_organization_id
          )
        )
    );
$$;

revoke all on function public.adviser_covers_organization(uuid, uuid) from public, anon;
grant execute on function public.adviser_covers_organization(uuid, uuid) to authenticated, service_role;

create or replace function public.protect_profile_assignment_fields()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if public.has_role(auth.uid(), 'admin') then
    return new;
  end if;
  if new.college_id is distinct from old.college_id
     or new.program_id is distinct from old.program_id
     or new.organization_id is distinct from old.organization_id
     or new.student_id is distinct from old.student_id then
    raise exception 'College, program, organization, and student ID cannot be changed from the profile.';
  end if;
  return new;
end;
$$;

comment on function public.protect_profile_assignment_fields() is
  'Blocks non-admin updates to profiles.college_id, program_id, organization_id, and student_id.';

create or replace function public.can_view_event_request(p_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with actor as (
    select ur.role, p.organization_id, p.college_id
    from public.user_roles ur
    left join public.profiles p on p.id = ur.user_id
    where ur.user_id = auth.uid()
  )
  select exists (
    select 1
    from public.event_requests r
    left join public.organizations o on o.id = r.organization_id
    cross join actor a
    where r.id = p_request_id
      and (r.deleted_at is null or a.role in ('admin', 'eo'))
      and (
        a.role in ('admin', 'eo')
        or r.submitted_by = auth.uid()
        or r.calendar_posted_at is not null
        or exists (
          select 1
          from public.student_feed_posts sfp
          where sfp.request_id = r.id
        )
        or (
          a.role = 'student_officer'
          and a.organization_id is not null
          and r.organization_id = a.organization_id
        )
        or (
          a.role = 'ssc'
          and (
            r.request_type = 'ssc'
            or exists (
              select 1
              from public.event_request_resource_assignments ra
              where ra.request_id = r.id
                and ra.assigned_office::text = 'ssc'
            )
          )
        )
        or (
          a.role = 'adviser'
          and public.adviser_covers_organization(auth.uid(), r.organization_id)
        )
        or (
          a.role = 'dean'
          and a.college_id is not null
          and o.college_id = a.college_id
        )
        or a.role = 'osas'
        or (
          a.role = 'gso'
          and (
            r.current_step = 'gso'
            or exists (
              select 1
              from public.event_request_resource_assignments ra
              where ra.request_id = r.id
                and ra.assigned_office::text = 'gso'
            )
          )
        )
        or (
          a.role in ('it_infrastructure', 'sports_office')
          and exists (
            select 1
            from public.event_request_resource_assignments ra
            where ra.request_id = r.id
              and ra.assigned_office::text = a.role::text
          )
        )
        or (
          a.role in ('infirmary', 'nstp')
          and r.calendar_posted_at is not null
        )
      )
  );
$$;

create or replace function public.can_access_event_request_details(p_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with actor as (
    select ur.role, p.organization_id, p.college_id
    from public.user_roles ur
    left join public.profiles p on p.id = ur.user_id
    where ur.user_id = auth.uid()
  )
  select exists (
    select 1
    from public.event_requests r
    left join public.organizations o on o.id = r.organization_id
    cross join actor a
    where r.id = p_request_id
      and (r.deleted_at is null or a.role in ('admin', 'eo'))
      and (
        a.role in ('admin', 'eo')
        or r.submitted_by = auth.uid()
        or (
          a.role = 'student_officer'
          and a.organization_id is not null
          and r.organization_id = a.organization_id
        )
        or (
          a.role = 'adviser'
          and public.adviser_covers_organization(auth.uid(), r.organization_id)
        )
        or (
          a.role = 'dean'
          and a.college_id is not null
          and o.college_id = a.college_id
        )
        or (a.role = 'osas' and r.current_step = 'osas')
        or (
          a.role = 'ssc'
          and (
            r.request_type = 'ssc'
            or exists (
              select 1
              from public.event_request_resource_assignments ra
              where ra.request_id = r.id
                and ra.assigned_office::text = 'ssc'
            )
          )
        )
        or (
          a.role = 'gso'
          and (
            r.current_step = 'gso'
            or exists (
              select 1
              from public.event_request_resource_assignments ra
              where ra.request_id = r.id
                and ra.assigned_office::text = 'gso'
            )
          )
        )
        or (
          a.role in ('it_infrastructure', 'sports_office')
          and exists (
            select 1
            from public.event_request_resource_assignments ra
            where ra.request_id = r.id
              and ra.assigned_office::text = a.role::text
          )
        )
      )
  );
$$;

create or replace function public.can_view_event_request_audit(p_request_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.event_requests r
    left join public.organizations o on o.id = r.organization_id
    where r.id = p_request_id
      and (
        r.submitted_by = auth.uid()
        or public.has_role(auth.uid(), 'admin')
        or public.has_role(auth.uid(), 'eo')
        or public.has_role(auth.uid(), 'osas')
        or (
          public.has_role(auth.uid(), 'ssc')
          and r.request_type = 'ssc'
        )
        or (
          public.has_role(auth.uid(), 'student_officer')
          and (
            r.submitted_by = auth.uid()
            or r.organization_id = (
              select p.organization_id from public.profiles p where p.id = auth.uid()
            )
          )
        )
        or (
          public.has_role(auth.uid(), 'adviser')
          and public.adviser_covers_organization(auth.uid(), r.organization_id)
        )
        or (
          public.has_role(auth.uid(), 'dean')
          and o.college_id is not null
          and o.college_id = (
            select p.college_id from public.profiles p where p.id = auth.uid()
          )
        )
        or (
          public.has_role(auth.uid(), 'gso')
          and (
            r.current_step = 'gso'
            or exists (
              select 1
              from public.event_request_resource_assignments a
              where a.request_id = r.id
                and a.assigned_office = 'gso'
            )
          )
        )
        or (
          public.has_role(auth.uid(), 'it_infrastructure')
          and exists (
            select 1
            from public.event_request_resource_assignments a
            where a.request_id = r.id
              and a.assigned_office = 'it_infrastructure'
          )
        )
        or (
          public.has_role(auth.uid(), 'sports_office')
          and exists (
            select 1
            from public.event_request_resource_assignments a
            where a.request_id = r.id
              and a.assigned_office = 'sports_office'
          )
        )
        or (
          (public.has_role(auth.uid(), 'infirmary') or public.has_role(auth.uid(), 'nstp'))
          and r.calendar_posted_at is not null
          and r.deleted_at is null
        )
      )
  );
$$;

create or replace function public.event_request_actor_can_handle(
  p_request public.event_requests,
  p_actor uuid,
  p_role public.app_role
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_role = 'admin' then true
    when p_role = 'adviser' and p_request.current_step = 'adviser' then
      public.adviser_covers_organization(p_actor, p_request.organization_id)
    when p_role = 'dean' and p_request.current_step = 'dean' then exists (
      select 1
      from public.profiles p
      join public.organizations o on o.id = p_request.organization_id
      where p.id = p_actor and p.college_id = o.college_id
    )
    when p_role = 'osas' then p_request.current_step = 'osas'
    when p_role = 'eo' then p_request.current_step in ('eo_schedule', 'eo_publish')
    when p_role = 'gso' then p_request.current_step = 'gso'
    else false
  end;
$$;

revoke all on function public.event_request_actor_can_handle(public.event_requests, uuid, public.app_role)
  from public, anon, authenticated;

create or replace function public.notify_next_workflow_reviewer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_step public.workflow_step;
  v_request record;
  v_step_label text;
  v_title text;
  v_body text;
  v_recipient uuid;
  v_notification_id uuid;
begin
  if new.action not in ('submitted', 'approved', 'resubmitted') then
    return new;
  end if;

  begin
    v_step := case
      when new.action = 'approved' then nullif(new.metadata ->> 'next_step', '')::public.workflow_step
      else new.step
    end;
    if v_step is null or v_step not in ('adviser', 'dean', 'osas', 'eo_schedule', 'gso') then
      return new;
    end if;

    select r.activity, r.start_date, r.end_date, r.start_time, r.end_time, r.venue,
           r.status, r.current_step, r.request_type, r.organization_id,
           o.name as organization_name, o.college_id
    into v_request
    from public.event_requests r
    left join public.organizations o on o.id = r.organization_id
    where r.id = new.request_id
      and r.deleted_at is null;

    if not found
       or v_request.status <> 'pending'
       or v_request.current_step is distinct from v_step then
      return new;
    end if;

    v_step_label := case v_step
      when 'adviser' then 'Adviser'
      when 'dean' then 'Dean'
      when 'osas' then 'OSAS'
      when 'eo_schedule' then 'EO scheduling'
      when 'gso' then 'GSO'
    end;
    v_title := case
      when new.action = 'resubmitted' then 'Resubmitted request awaiting your review'
      else 'Event request awaiting your review'
    end;
    v_body := format(
      '"%s" from %s is waiting for %s review. %s to %s, %s-%s at %s.',
      v_request.activity,
      case
        when v_request.request_type = 'ssc' then 'SSC'
        else coalesce(nullif(trim(v_request.organization_name), ''), 'an organization')
      end,
      v_step_label,
      v_request.start_date,
      v_request.end_date,
      left(coalesce(v_request.start_time::text, 'TBA'), 5),
      left(coalesce(v_request.end_time::text, 'TBA'), 5),
      coalesce(nullif(trim(v_request.venue), ''), 'TBA')
    );

    for v_recipient in
      select ur.user_id
      from public.user_roles ur
      left join public.profiles p on p.id = ur.user_id
      where ur.user_id is distinct from new.actor_id
        and case v_step
          when 'adviser' then ur.role = 'adviser'
            and public.adviser_covers_organization(p.id, v_request.organization_id)
          when 'dean' then ur.role = 'dean'
            and v_request.college_id is not null
            and p.college_id = v_request.college_id
          when 'osas' then ur.role = 'osas'
          when 'eo_schedule' then ur.role = 'eo'
          when 'gso' then ur.role = 'gso'
          else false
        end
      order by ur.user_id
      limit 50
    loop
      v_notification_id := null;

      insert into public.notifications (
        user_id, title, body, category, request_id, actor_id, dedup_key, event_type
      ) values (
        v_recipient, v_title, v_body, 'approval', new.request_id, new.actor_id,
        'review_required:' || new.id::text, 'review_required'
      )
      on conflict (user_id, dedup_key) where dedup_key is not null do nothing
      returning id into v_notification_id;

      if v_notification_id is not null then
        insert into public.notification_email_outbox (notification_id)
        values (v_notification_id)
        on conflict (notification_id) do nothing;
      end if;
    end loop;
  exception
    when others then
      raise warning 'Reviewer notification skipped for history %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

revoke all on function public.notify_next_workflow_reviewer() from public, anon, authenticated;

create or replace function public.enqueue_current_step_review_notifications(p_request_id uuid)
returns setof uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_request record;
  v_step public.workflow_step;
  v_history_id uuid;
  v_label text;
  v_title text;
  v_body text;
  v_recipient uuid;
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  select r.id, r.activity, r.start_date, r.end_date, r.start_time, r.end_time, r.venue,
         r.status, r.current_step, r.request_type, r.organization_id, r.deleted_at,
         o.name as organization_name, o.college_id
  into v_request
  from public.event_requests r
  left join public.organizations o on o.id = r.organization_id
  where r.id = p_request_id;

  if not found or v_request.deleted_at is not null then
    return;
  end if;
  if v_request.status <> 'pending'
     or v_request.current_step not in ('adviser', 'dean', 'osas', 'eo_schedule') then
    return;
  end if;
  if not exists (
    select 1
    from public.event_request_history h
    where h.request_id = p_request_id
      and h.actor_id = v_actor
      and h.created_at > now() - interval '5 minutes'
  ) then
    raise exception 'Not authorized to notify reviewers for this request.' using errcode = '42501';
  end if;

  v_step := v_request.current_step;
  select h.id into v_history_id
  from public.event_request_history h
  where h.request_id = p_request_id
    and h.actor_id = v_actor
  order by h.created_at desc
  limit 1;

  v_label := case v_step
    when 'adviser' then 'Adviser'
    when 'dean' then 'Dean'
    when 'osas' then 'OSAS'
    when 'eo_schedule' then 'Executive Officer'
  end;
  v_title := 'Event request awaiting your review';
  v_body := format(
    '"%s" from %s is waiting for %s review. %s to %s, %s-%s at %s. Sign in to EventLink to review it.',
    v_request.activity,
    case
      when v_request.request_type = 'ssc' then 'SSC'
      else coalesce(nullif(trim(v_request.organization_name), ''), 'an organization')
    end,
    v_label,
    v_request.start_date,
    v_request.end_date,
    left(coalesce(v_request.start_time::text, 'TBA'), 5),
    left(coalesce(v_request.end_time::text, 'TBA'), 5),
    coalesce(nullif(trim(v_request.venue), ''), 'TBA')
  );

  for v_recipient in
    select ur.user_id
    from public.user_roles ur
    left join public.profiles p on p.id = ur.user_id
    where ur.user_id is distinct from v_actor
      and case v_step
        when 'adviser' then ur.role = 'adviser'
          and public.adviser_covers_organization(p.id, v_request.organization_id)
        when 'dean' then ur.role = 'dean'
          and v_request.college_id is not null
          and p.college_id = v_request.college_id
        when 'osas' then ur.role = 'osas'
        when 'eo_schedule' then ur.role = 'eo'
        else false
      end
    order by ur.user_id
    limit 20
  loop
    insert into public.notifications (
      user_id, title, body, category, request_id, actor_id, dedup_key
    ) values (
      v_recipient,
      v_title,
      v_body,
      'approval',
      p_request_id,
      v_actor,
      'review_required:' || p_request_id::text || ':' || v_step::text || ':' || v_history_id::text
    )
    on conflict (user_id, dedup_key) where dedup_key is not null do nothing
    returning id into v_id;

    if v_id is not null then
      insert into public.notification_email_outbox (notification_id)
      values (v_id)
      on conflict (notification_id) do nothing;
      return next v_id;
    end if;
    v_id := null;
  end loop;
end;
$$;

revoke all on function public.enqueue_current_step_review_notifications(uuid)
  from public, anon, authenticated;
grant execute on function public.enqueue_current_step_review_notifications(uuid) to authenticated;

create or replace function public.admin_list_portal_users_page(
  p_search text default null,
  p_role public.app_role default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  user_id uuid,
  app_role public.app_role,
  display_name text,
  email text,
  student_id text,
  college text,
  program text,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_q text := nullif(lower(trim(coalesce(p_search, ''))), '');
begin
  if not public.has_role(auth.uid(), 'admin') then
    raise exception 'not authorized';
  end if;

  return query
  with base as (
    select
      ur.user_id,
      ur.role as app_role,
      coalesce(nullif(trim(p.display_name), ''), '')::text as display_name,
      coalesce(p.email, '')::text as email,
      coalesce(p.student_id, '')::text as student_id,
      coalesce(
        nullif(trim(s.course), ''),
        nullif(trim(c.name), ''),
        ''
      )::text as college,
      coalesce(
        nullif(trim(s.program), ''),
        nullif(trim(prog.name), ''),
        nullif(trim(o.name), ''),
        ''
      )::text as program
    from public.user_roles ur
    left join public.profiles p on p.id = ur.user_id
    left join public.students s
      on p.student_id is not null
      and upper(trim(s.student_id)) = upper(trim(p.student_id))
      and not s.archived
    left join public.colleges c on c.id = p.college_id
    left join public.programs prog on prog.id = p.program_id
    left join public.organizations o on o.id = p.organization_id
    where (p_role is null or ur.role = p_role)
      and (
        v_q is null
        or lower(coalesce(p.display_name, '')) like '%' || v_q || '%'
        or lower(coalesce(p.email, '')) like '%' || v_q || '%'
        or ur.user_id::text like '%' || v_q || '%'
        or lower(ur.role::text) like '%' || v_q || '%'
      )
  ),
  counted as (
    select b.*, (select count(*) from base)::bigint as total_count
    from base b
  )
  select *
  from counted
  order by display_name asc, email asc
  limit v_limit
  offset v_offset;
end;
$$;

revoke all on function public.admin_list_portal_users_page(text, public.app_role, integer, integer)
  from public, anon, authenticated;
grant execute on function public.admin_list_portal_users_page(text, public.app_role, integer, integer)
  to authenticated;
