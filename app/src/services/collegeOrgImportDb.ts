import { getSupabase } from "@/lib/supabase";
import { assignOrganizationToProgram, ensureProgram, fetchCollegesWithOrganizations } from "@/services/organizationsDb";
import type { CollegeOrgImportPreviewRow } from "@/services/collegeOrgImportParser";

export type CollegeOrgImportResult = {
  ok: boolean;
  error?: string;
  collegesCreated: number;
  organizationsCreated: number;
  reused: number;
  failed: number;
};

type RpcPayload = {
  ok?: boolean;
  error?: string;
  colleges_created?: number;
  organizations_created?: number;
  reused?: number;
  failed?: number;
};

export async function importCollegesOrganizations(
  rows: CollegeOrgImportPreviewRow[],
): Promise<CollegeOrgImportResult> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("admin_import_colleges_organizations", {
    p_rows: rows.map((row) => ({
      row: row.row,
      college_name: row.collegeName,
      organization_name: row.organizationName,
      organization_code: row.organizationCode,
    })),
  });

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("permission") || msg.includes("not authorized") || msg.includes("42501")) {
      throw new Error("You do not have permission to perform this action.");
    }
    throw new Error("Import failed. No changes were applied.");
  }

  const payload = (data ?? {}) as RpcPayload;
  if (!payload.ok) {
    throw new Error(payload.error || "Import failed. No changes were applied.");
  }

  await attachImportedPrograms(rows);

  return {
    ok: true,
    collegesCreated: payload.colleges_created ?? 0,
    organizationsCreated: payload.organizations_created ?? 0,
    reused: payload.reused ?? 0,
    failed: payload.failed ?? 0,
  };
}

async function attachImportedPrograms(rows: CollegeOrgImportPreviewRow[]): Promise<void> {
  const pending = rows.filter(
    (row) => row.programName.trim() && row.status !== "Invalid",
  );
  if (!pending.length) return;

  const colleges = await fetchCollegesWithOrganizations();
  for (const row of pending) {
    const college = colleges.find(
      (item) => item.name.trim().toLowerCase() === row.collegeName.trim().toLowerCase(),
    );
    if (!college) continue;
    const programId = await ensureProgram(college.id, row.programName);
    const org = college.organizations.find(
      (item) => item.name.trim().toLowerCase() === row.organizationName.trim().toLowerCase(),
    );
    if (!org) {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from("organizations")
        .select("id")
        .eq("college_id", college.id)
        .ilike("name", row.organizationName.trim())
        .maybeSingle();
      if (error || !data?.id) continue;
      await assignOrganizationToProgram(data.id as string, programId, row.organizationCode);
      continue;
    }
    await assignOrganizationToProgram(org.id, programId, row.organizationCode);
  }
}
