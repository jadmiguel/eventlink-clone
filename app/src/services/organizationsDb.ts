import { getSupabase } from "@/lib/supabase";
import type { DbRequestType } from "@/types/eventRequest";

export type OrganizationOption = {
  id: string;
  name: string;
  college_id?: string;
};

/** SSC is the organization itself — not a college student org. */
export const SSC_ORGANIZATION_NAME = "SSC";

/** SSC lives under this college in the DB (university-wide, not CCSICT/CBA/etc.). */
export const UNIVERSITY_WIDE_COLLEGE_CODE = "UNIV";

export async function fetchSscOrganization(): Promise<OrganizationOption | null> {
  const supabase = getSupabase();
  const { data: bySlug, error: slugErr } = await supabase
    .from("organizations")
    .select("id, name, college_id")
    .eq("slug", "ssc")
    .maybeSingle();
  if (slugErr) throw slugErr;
  if (bySlug) return bySlug as OrganizationOption;

  const { data: byName, error: nameErr } = await supabase
    .from("organizations")
    .select("id, name, college_id")
    .ilike("name", SSC_ORGANIZATION_NAME)
    .limit(1)
    .maybeSingle();
  if (nameErr) throw nameErr;
  return (byName as OrganizationOption | null) ?? null;
}

export async function fetchOrganizations(collegeId?: string | null): Promise<OrganizationOption[]> {
  const supabase = getSupabase();
  let query = supabase.from("organizations").select("id, name, college_id").order("name");
  if (collegeId) query = query.eq("college_id", collegeId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as OrganizationOption[];
}

/** Organizations available when creating an event (college-scoped for officers). */
export async function fetchOrganizationsForSubmit(
  userId: string,
  requestType: DbRequestType,
): Promise<OrganizationOption[]> {
  if (requestType === "ssc") {
    const ssc = await fetchSscOrganization();
    return ssc ? [ssc] : [];
  }

  const supabase = getSupabase();
  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("college_id, organization_id")
    .eq("id", userId)
    .maybeSingle();
  if (profileErr) throw profileErr;

  let collegeId = profile?.college_id ?? null;
  if (!collegeId && profile?.organization_id) {
    const { data: org, error: orgErr } = await supabase
      .from("organizations")
      .select("college_id")
      .eq("id", profile.organization_id)
      .maybeSingle();
    if (orgErr) throw orgErr;
    collegeId = org?.college_id ?? null;
  }

  return fetchOrganizations(collegeId);
}

export type OrgOption = {
  id: string;
  name: string;
  slug: string | null;
  program_id: string | null;
};

export type ProgramWithOrgs = {
  id: string;
  name: string;
  code: string | null;
  organizations: OrgOption[];
};

export type CollegeWithOrgs = {
  id: string;
  name: string;
  code: string | null;
  programs: ProgramWithOrgs[];
  unassignedOrganizations: OrgOption[];
  organizations: OrgOption[];
};

export async function fetchCollegesWithOrganizations(): Promise<CollegeWithOrgs[]> {
  const supabase = getSupabase();
  const { data: colleges, error: cErr } = await supabase
    .from("colleges")
    .select("id, name, code")
    .order("name");
  if (cErr) throw cErr;

  const [{ data: orgs, error: oErr }, { data: programs, error: pErr }] = await Promise.all([
    supabase.from("organizations").select("id, name, slug, college_id, program_id").order("name"),
    supabase.from("programs").select("id, name, code, college_id").order("name"),
  ]);
  if (oErr) throw oErr;
  if (pErr) throw pErr;

  return (colleges ?? []).map((c) => {
    const collegeOrgs = (orgs ?? [])
      .filter((o) => o.college_id === c.id)
      .map((o) => ({
        id: o.id as string,
        name: o.name as string,
        slug: o.slug as string | null,
        program_id: (o.program_id as string | null) ?? null,
      }));
    const collegePrograms = (programs ?? [])
      .filter((p) => p.college_id === c.id)
      .map((p) => ({
        id: p.id as string,
        name: p.name as string,
        code: (p.code as string | null) ?? null,
        organizations: collegeOrgs.filter((o) => o.program_id === p.id),
      }));
    return {
      id: c.id as string,
      name: c.name as string,
      code: c.code as string | null,
      programs: collegePrograms,
      unassignedOrganizations: collegeOrgs.filter((o) => !o.program_id),
      organizations: collegeOrgs,
    };
  });
}

export async function createCollege(name: string, code: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("colleges").insert({
    name: name.trim(),
    code: code.trim().toUpperCase() || null,
  });
  if (error) throw error;
}

export async function updateCollege(
  id: string,
  name: string,
  code: string,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("colleges")
    .update({
      name: name.trim(),
      code: code.trim().toUpperCase() || null,
    })
    .eq("id", id);
  if (error) throw error;
}

export async function createProgram(collegeId: string, name: string, code?: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("programs").insert({
    college_id: collegeId,
    name: name.trim(),
    code: code?.trim().toUpperCase() || null,
  });
  if (error) throw error;
}

export async function deleteProgram(id: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("programs").delete().eq("id", id);
  if (error) throw error;
}

export async function ensureProgram(collegeId: string, name: string): Promise<string> {
  const supabase = getSupabase();
  const trimmed = name.trim();
  const { data, error } = await supabase
    .from("programs")
    .select("id, name")
    .eq("college_id", collegeId);
  if (error) throw error;
  const existing = (data ?? []).find(
    (row) => String(row.name ?? "").trim().toLowerCase() === trimmed.toLowerCase(),
  );
  if (existing?.id) return existing.id as string;

  const { data: created, error: insertError } = await supabase
    .from("programs")
    .insert({ college_id: collegeId, name: trimmed })
    .select("id")
    .single();
  if (insertError) throw insertError;
  return created.id as string;
}

export async function assignOrganizationToProgram(
  organizationId: string,
  programId: string,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("organizations")
    .update({ program_id: programId })
    .eq("id", organizationId);
  if (error) throw error;
}

export async function createOrganization(
  collegeId: string,
  name: string,
  slug?: string,
  programId?: string | null,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("organizations").insert({
    college_id: collegeId,
    program_id: programId || null,
    name: name.trim(),
    slug: slug?.trim() || null,
  });
  if (error) throw error;
}

export async function deleteOrganization(id: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("organizations").delete().eq("id", id);
  if (error) throw error;
}
