import { getSupabase } from "@/lib/supabase";
import { fetchCollegesWithOrganizations } from "@/services/collegesDb";
import { fetchRequireIsuEmail } from "@/services/appSettingsDb";
import { fetchAdminOrgAssignments, fetchAdminPortalUsers, type AdminPortalUserRow } from "@/services/adminUsersDb";
import type {
  StaffImportCatalog,
  StaffImportKind,
  StaffImportPreviewRow,
} from "@/services/staffImportParser";

export type StaffImportRowResult = {
  row: number;
  full_name: string;
  email: string;
  college: string;
  organization: string;
  position: string;
  status: string;
  message: string;
};

export type StaffImportResult = {
  total: number;
  successful: number;
  failed: number;
  skipped: number;
  invitations: number;
  rows: StaffImportRowResult[];
};

export async function fetchStaffImportCatalog(): Promise<StaffImportCatalog> {
  const [requireIsuEmail, colleges, users, assignments] = await Promise.all([
    fetchRequireIsuEmail().catch(() => true),
    fetchCollegesWithOrganizations(),
    fetchAdminPortalUsers(),
    fetchAdminOrgAssignments().catch(() => []),
  ]);

  return {
    requireIsuEmail,
    colleges: colleges.map((c) => ({
      id: c.id,
      name: c.name,
      code: c.code,
      organizations: c.organizations.map((o) => ({ id: o.id, name: o.name, slug: o.slug })),
      programs: c.programs.map((program) => ({ id: program.id, name: program.name })),
    })),
    portalUsers: ((users ?? []) as AdminPortalUserRow[]).map((u) => ({
      email: u.email ?? "",
      role: String(u.app_role ?? ""),
      college: u.college ?? "",
    })),
    orgAssignments: assignments.map((a) => ({
      organizationId: a.organization_id,
      role: String(a.app_role ?? ""),
      displayName: a.display_name ?? "",
    })),
  };
}

export async function importStaffAccounts(
  kind: StaffImportKind,
  rows: StaffImportPreviewRow[],
): Promise<StaffImportResult> {
  const supabase = getSupabase();
  const { data, error } = await supabase.functions.invoke("admin-bulk-provision", {
    body: {
      role: kind,
      rows: rows.map((row) => ({
        row: row.row,
        full_name: row.fullName,
        email: row.email,
        college: row.college,
        program: row.program,
        organization: row.organization,
        position: row.position,
      })),
    },
  });

  const payload = data as (Partial<StaffImportResult> & { ok?: boolean; error?: string }) | null;
  if (payload?.error) throw new Error(payload.error);
  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("failed to send a request") || msg.includes("non-2xx") || msg.includes("not found")) {
      throw new Error("Admin bulk-provision function is not available. Deploy supabase function: admin-bulk-provision.");
    }
    throw new Error("Import failed. Some rows may not have been processed.");
  }
  if (!payload) throw new Error("Import failed. No response from the server.");

  return {
    total: payload.total ?? rows.length,
    successful: payload.successful ?? 0,
    failed: payload.failed ?? 0,
    skipped: payload.skipped ?? 0,
    invitations: payload.invitations ?? 0,
    rows: payload.rows ?? [],
  };
}
