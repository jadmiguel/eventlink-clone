-- The same organization name can belong to different programs in one college.
-- Each program still cannot have two organizations with the same name.

alter table public.organizations
  drop constraint if exists organizations_college_id_name_key;

create unique index if not exists organizations_program_name_unique
  on public.organizations (program_id, lower(btrim(name)))
  where program_id is not null;

create or replace function public.admin_import_colleges_organizations(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_len integer;
  v_elem jsonb;
  v_row_no integer;
  v_college_name text;
  v_org_name text;
  v_org_code text;
  v_slug text;
  v_status text;
  v_message text;
  v_has_invalid boolean := false;
  v_college_id uuid;
  v_college_ids uuid[];
  v_org_id uuid;
  v_slug_owner text;
  v_new_code text;
  v_suffix integer;
  v_colleges_created integer := 0;
  v_orgs_created integer := 0;
  v_reused integer := 0;
  v_row_results jsonb := '[]'::jsonb;
  v_created_college_names text[] := '{}';
  v_created_org_keys text[] := '{}';
  v_created_slug_keys text[] := '{}';
  v_seen_name_keys text[] := '{}';
  v_seen_slug_keys text[] := '{}';
  v_name_key text;
  v_slug_key text;
  v_is_new_college boolean;
begin
  if auth.uid() is null or not public.has_role(auth.uid(), 'admin') then
    return jsonb_build_object(
      'ok', false,
      'error', 'You do not have permission to perform this action.',
      'colleges_created', 0,
      'organizations_created', 0,
      'reused', 0,
      'failed', 0,
      'rows', '[]'::jsonb
    );
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object(
      'ok', false,
      'error', 'Import payload is invalid.',
      'colleges_created', 0,
      'organizations_created', 0,
      'reused', 0,
      'failed', 0,
      'rows', '[]'::jsonb
    );
  end if;

  v_len := jsonb_array_length(p_rows);
  if v_len = 0 then
    return jsonb_build_object(
      'ok', false,
      'error', 'There are no rows to import.',
      'colleges_created', 0,
      'organizations_created', 0,
      'reused', 0,
      'failed', 0,
      'rows', '[]'::jsonb
    );
  end if;

  if v_len > 200 then
    return jsonb_build_object(
      'ok', false,
      'error', 'Too many rows. Import at most 200 organizations at a time.',
      'colleges_created', 0,
      'organizations_created', 0,
      'reused', 0,
      'failed', 0,
      'rows', '[]'::jsonb
    );
  end if;

  for v_elem in select value from jsonb_array_elements(p_rows)
  loop
    v_row_no := coalesce(nullif(v_elem ->> 'row', '')::integer, 0);
    v_college_name := btrim(coalesce(v_elem ->> 'college_name', ''));
    v_org_name := btrim(coalesce(v_elem ->> 'organization_name', ''));
    v_org_code := btrim(coalesce(v_elem ->> 'organization_code', ''));
    v_slug := trim(both '-' from regexp_replace(lower(v_org_code), '[^a-z0-9]+', '-', 'g'));
    v_status := 'Valid';
    v_message := 'New organization will be created.';
    v_college_id := null;
    v_org_id := null;
    v_is_new_college := false;

    if v_college_name = '' and v_org_name = '' and v_org_code = '' then
      continue;
    end if;

    if lower(v_college_name) like 'example %'
       or lower(v_org_name) like 'example %'
       or v_slug like 'example-%' then
      continue;
    end if;

    if v_college_name = '' then
      v_status := 'Invalid';
      v_message := 'College name is required.';
    elsif v_org_name = '' then
      v_status := 'Invalid';
      v_message := 'Organization name is required.';
    elsif v_org_code = '' or v_slug = '' then
      v_status := 'Invalid';
      v_message := 'Organization code is required.';
    elsif char_length(v_college_name) > 200 or char_length(v_org_name) > 200 or char_length(v_slug) > 64 then
      v_status := 'Invalid';
      v_message := 'A value is too long.';
    elsif v_slug = 'ssc' then
      v_status := 'Invalid';
      v_message := 'Organization code "ssc" is reserved for the university-wide SSC organization.';
    else
      v_name_key := lower(v_college_name) || chr(31) || lower(v_org_name);
      v_slug_key := lower(v_college_name) || chr(31) || v_slug;

      if v_slug_key = any (v_seen_slug_keys) then
        v_status := 'Invalid';
        v_message := format(
          'Duplicate organization code "%s" under "%s" in this file.',
          v_slug,
          v_college_name
        );
      else
        v_seen_name_keys := array_append(v_seen_name_keys, v_name_key);
        v_seen_slug_keys := array_append(v_seen_slug_keys, v_slug_key);

        select array_agg(c.id)
        into v_college_ids
        from public.colleges c
        where lower(btrim(c.name)) = lower(v_college_name);

        if coalesce(array_length(v_college_ids, 1), 0) > 1 then
          v_status := 'Invalid';
          v_message := format(
            'Multiple colleges are named "%s". Rename the duplicates in Admin before importing.',
            v_college_name
          );
        elsif coalesce(array_length(v_college_ids, 1), 0) = 1 then
          v_college_id := v_college_ids[1];
        else
          v_is_new_college := true;
        end if;

        if v_status = 'Valid' and v_college_id is not null then
          select o.id
          into v_org_id
          from public.organizations o
          where o.college_id = v_college_id
            and lower(btrim(o.name)) = lower(v_org_name)
          limit 1;

          if v_org_id is not null then
            select o.name
            into v_slug_owner
            from public.organizations o
            where o.college_id = v_college_id
              and o.slug is not null
              and lower(btrim(o.slug)) = v_slug
            limit 1;

            if v_slug_owner is null then
              v_status := 'Valid';
              v_message := 'New organization will be added to the existing college.';
            elsif lower(btrim(v_slug_owner)) = lower(v_org_name) then
              v_status := 'Duplicate';
              v_message := format(
                'Organization "%s" already exists under "%s".',
                v_org_name,
                v_college_name
              );
            else
              v_status := 'Invalid';
              v_message := format(
                'Organization code "%s" is already used by "%s" under "%s".',
                v_slug,
                v_slug_owner,
                v_college_name
              );
            end if;
          else
            select o.name
            into v_slug_owner
            from public.organizations o
            where o.college_id = v_college_id
              and o.slug is not null
              and lower(btrim(o.slug)) = v_slug
            limit 1;

            if v_slug_owner is not null then
              v_status := 'Invalid';
              v_message := format(
                'Organization code "%s" is already used by "%s" under "%s".',
                v_slug,
                v_slug_owner,
                v_college_name
              );
            else
              v_status := 'Valid';
              v_message := 'New organization will be added to the existing college.';
            end if;
          end if;
        elsif v_status = 'Valid' and v_is_new_college then
          v_status := 'Warning';
          v_message := format('College "%s" will be created with this organization.', v_college_name);
        end if;
      end if;
    end if;

    if v_status = 'Invalid' then
      v_has_invalid := true;
    end if;

    v_row_results := v_row_results || jsonb_build_array(
      jsonb_build_object(
        'row', v_row_no,
        'college_name', v_college_name,
        'organization_name', v_org_name,
        'organization_code', v_slug,
        'status', v_status,
        'message', v_message
      )
    );
  end loop;

  if v_has_invalid or jsonb_array_length(v_row_results) = 0 then
    return jsonb_build_object(
      'ok', false,
      'error', case
        when jsonb_array_length(v_row_results) = 0 then 'There are no importable rows.'
        else 'Fix invalid rows before importing. No changes were applied.'
      end,
      'colleges_created', 0,
      'organizations_created', 0,
      'reused', 0,
      'failed', (
        select count(*)::integer
        from jsonb_array_elements(v_row_results) r
        where r ->> 'status' = 'Invalid'
      ),
      'rows', v_row_results
    );
  end if;

  for v_elem in select value from jsonb_array_elements(v_row_results)
  loop
    v_status := v_elem ->> 'status';
    v_college_name := v_elem ->> 'college_name';
    v_org_name := v_elem ->> 'organization_name';
    v_slug := v_elem ->> 'organization_code';

    if v_status = 'Duplicate' then
      v_reused := v_reused + 1;
      continue;
    end if;

    select c.id
    into v_college_id
    from public.colleges c
    where lower(btrim(c.name)) = lower(v_college_name)
    limit 1;

    if v_college_id is null then
      v_new_code := upper(left(regexp_replace(v_college_name, '[^A-Za-z0-9]', '', 'g'), 8));
      if char_length(v_new_code) < 2 then
        v_new_code := 'COLLEGE';
      end if;
      v_suffix := 2;
      while exists (select 1 from public.colleges c where c.code = v_new_code) loop
        v_new_code := left(v_new_code, 6) || v_suffix::text;
        v_suffix := v_suffix + 1;
      end loop;

      insert into public.colleges (name, code)
      values (v_college_name, v_new_code)
      returning id into v_college_id;

      if not (lower(v_college_name) = any (v_created_college_names)) then
        v_created_college_names := array_append(v_created_college_names, lower(v_college_name));
        v_colleges_created := v_colleges_created + 1;
      end if;
    end if;

    v_slug_key := v_college_id::text || chr(31) || v_slug;
    if v_slug_key = any (v_created_slug_keys) then
      v_reused := v_reused + 1;
      continue;
    end if;

    if exists (
      select 1
      from public.organizations o
      where o.college_id = v_college_id
        and o.slug is not null
        and lower(btrim(o.slug)) = v_slug
    ) then
      v_reused := v_reused + 1;
      continue;
    end if;

    insert into public.organizations (college_id, name, slug)
    values (v_college_id, v_org_name, v_slug);

    v_created_slug_keys := array_append(v_created_slug_keys, v_slug_key);
    v_orgs_created := v_orgs_created + 1;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'colleges_created', v_colleges_created,
    'organizations_created', v_orgs_created,
    'reused', v_reused,
    'failed', 0,
    'rows', v_row_results
  );
exception
  when unique_violation then
    raise warning 'admin_import_colleges_organizations unique_violation: %', sqlerrm;
    return jsonb_build_object(
      'ok', false,
      'error', 'Import failed because a college or organization already exists. No changes were applied.',
      'colleges_created', 0,
      'organizations_created', 0,
      'reused', 0,
      'failed', 1,
      'rows', '[]'::jsonb
    );
  when others then
    raise warning 'admin_import_colleges_organizations: %', sqlerrm;
    return jsonb_build_object(
      'ok', false,
      'error', 'Import failed. No changes were applied.',
      'colleges_created', 0,
      'organizations_created', 0,
      'reused', 0,
      'failed', 1,
      'rows', '[]'::jsonb
    );
end;
$$;

revoke all on function public.admin_import_colleges_organizations(jsonb) from public, anon;
grant execute on function public.admin_import_colleges_organizations(jsonb) to authenticated;

comment on function public.admin_import_colleges_organizations(jsonb) is
  'Admin-only transactional college/organization import. organization_code is stored as organizations.slug.';
