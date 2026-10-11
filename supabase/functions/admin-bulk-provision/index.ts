import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ISU_EMAIL_DOMAIN = "isu.edu.ph";
const ISU_EMAIL_ERROR = "Please use a valid ISU email address.";
const MAX_ROWS = 100;
const STUDENT_ID_PATTERN = /^[0-9]{2}-[0-9]{4}$/;
const ALLOWED_ROLES = new Set(["student_officer", "adviser", "dean"]);

type ForcedRole = "student_officer" | "adviser" | "dean";

type IncomingRow = {
  row?: number;
  student_id?: string;
  full_name?: string;
  email?: string;
  college?: string;
  program?: string;
  year_level?: string;
  organization?: string;
  position?: string;
  role?: string;
  password?: string;
};

type RowResult = {
  row: number;
  student_id: string;
  full_name: string;
  email: string;
  college: string;
  organization: string;
  position: string;
  status: "Valid" | "Invalid" | "Duplicate" | "Warning" | "Success" | "Failed" | "Skipped";
  message: string;
};

type ClassifiedRow = RowResult & {
  collegeId?: string;
  programId?: string;
  organizationId?: string;
  displayName?: string;
  program?: string;
  yearLevel?: string;
  createStudent?: boolean;
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function roleLabel(role: ForcedRole): string {
  if (role === "dean") return "Dean";
  if (role === "adviser") return "Adviser";
  return "Student Officer";
}

function emailParts(email: string): { local: string; domain: string } | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!local || !domain) return null;
  return { local, domain };
}

function isValidEmailAddress(email: string): boolean {
  const parts = emailParts(email);
  if (!parts) return false;
  const { domain } = parts;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
  return !domain.includes(" ") && !parts.local.includes(" ");
}

function isOfficialIsuEmail(email: string): boolean {
  const parts = emailParts(email);
  return Boolean(parts?.local) && parts?.domain === ISU_EMAIL_DOMAIN;
}

function emailMeetsAdminPolicy(email: string, requireIsuEmail: boolean): boolean {
  if (!isValidEmailAddress(email)) return false;
  if (requireIsuEmail) return isOfficialIsuEmail(email);
  return true;
}

function normalizeStudentId(raw: string): string {
  return raw.trim().toUpperCase();
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isExampleRow(row: IncomingRow): boolean {
  const name = String(row.full_name ?? "").trim().toLowerCase();
  const email = String(row.email ?? "").trim().toLowerCase();
  const college = String(row.college ?? "").trim().toLowerCase();
  return name.startsWith("example ") || email.startsWith("example.") || college.startsWith("example ");
}

function inviteRedirect(): string | undefined {
  const origins = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (!origins[0]) return undefined;
  return `${origins[0].replace(/\/$/, "")}/reset-password`;
}

async function loadRequireIsuEmail(admin: SupabaseClient): Promise<boolean> {
  const { data, error } = await admin.from("app_settings").select("require_isu_email").eq("id", 1).maybeSingle();
  if (error) throw error;
  return data?.require_isu_email === true;
}

async function emailAlreadyRegistered(admin: SupabaseClient, email: string): Promise<boolean> {
  const getter = (
    admin.auth.admin as { getUserByEmail?: (value: string) => Promise<{ data: { user: unknown } | null }> }
  ).getUserByEmail;
  if (typeof getter === "function") {
    const { data } = await getter.call(admin.auth.admin, email);
    return Boolean(data?.user);
  }
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  return (data?.users ?? []).some((u) => (u.email ?? "").toLowerCase() === email);
}

function matchCollege(
  colleges: Array<{ id: string; name: string; code: string | null }>,
  collegeName: string,
) {
  return colleges.filter(
    (c) => c.name.trim().toLowerCase() === collegeName.toLowerCase() || (c.code ?? "").toLowerCase() === collegeName.toLowerCase(),
  );
}

function matchOrg(
  orgs: Array<{ id: string; name: string; slug: string | null; college_id: string }>,
  collegeId: string,
  organization: string,
) {
  const orgKey = organization.toLowerCase();
  const orgMatches = orgs.filter((o) => o.college_id === collegeId).filter(
    (o) =>
      o.name.trim().toLowerCase() === orgKey ||
      (o.slug ?? "").toLowerCase() === orgKey ||
      normalizeSlug(o.name) === normalizeSlug(organization),
  );
  const orgInOtherCollege = orgs.find(
    (o) =>
      o.college_id !== collegeId &&
      (o.name.trim().toLowerCase() === orgKey || (o.slug ?? "").toLowerCase() === orgKey),
  );
  return { orgMatches, orgInOtherCollege };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed." });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const accessToken = req.headers.get("Authorization")?.replace("Bearer ", "").trim();
  if (!url || !serviceKey || !anonKey || !accessToken) {
    return json(500, { error: "Missing function configuration or auth token." });
  }

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const authClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const {
    data: { user: requester },
    error: authErr,
  } = await authClient.auth.getUser();
  if (authErr || !requester) return json(401, { error: "Unauthorized." });

  const { data: roleRow, error: roleErr } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", requester.id)
    .maybeSingle();
  if (roleErr || roleRow?.role !== "admin") {
    return json(403, { error: "Only admin users can import portal accounts." });
  }

  let body: { role?: string; rows?: IncomingRow[] };
  try {
    body = (await req.json()) as { role?: string; rows?: IncomingRow[] };
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const requested = String(body.role ?? "student_officer").trim().toLowerCase();
  if (!ALLOWED_ROLES.has(requested)) {
    return json(400, { error: "This import can only create Student Officer, Adviser, or Dean accounts." });
  }
  const forcedRole = requested as ForcedRole;
  const label = roleLabel(forcedRole);

  const incoming = Array.isArray(body.rows) ? body.rows : [];
  if (!incoming.length) return json(400, { error: "There are no rows to import." });
  if (incoming.length > MAX_ROWS) {
    return json(400, { error: `Import at most ${MAX_ROWS} ${label}s at a time.` });
  }

  let requireIsuEmail = true;
  try {
    requireIsuEmail = await loadRequireIsuEmail(admin);
  } catch (error) {
    console.error("[admin-bulk-provision] app_settings", error);
    return json(500, { error: "Could not load application settings." });
  }

  const { data: collegeRows, error: collegeErr } = await admin.from("colleges").select("id, name, code");
  if (collegeErr) return json(500, { error: "Could not load colleges." });
  const { data: orgRows, error: orgErr } = await admin.from("organizations").select("id, name, slug, college_id");
  if (orgErr) return json(500, { error: "Could not load organizations." });
  const { data: programRows, error: programErr } = await admin.from("programs").select("id, name, college_id");
  if (programErr) return json(500, { error: "Could not load programs." });

  const colleges = (collegeRows ?? []) as Array<{ id: string; name: string; code: string | null }>;
  const orgs = (orgRows ?? []) as Array<{ id: string; name: string; slug: string | null; college_id: string }>;
  const programs = (programRows ?? []) as Array<{ id: string; name: string; college_id: string }>;

  const { data: allRoles, error: allRolesErr } = await admin.from("user_roles").select("user_id, role");
  if (allRolesErr) return json(500, { error: "Could not load roles." });
  const roleByUser = new Map(((allRoles ?? []) as Array<{ user_id: string; role: string }>).map((r) => [r.user_id, r.role]));

  const { data: allProfiles, error: allProfilesErr } = await admin
    .from("profiles")
    .select("id, email, student_id, college_id, organization_id");
  if (allProfilesErr) return json(500, { error: "Could not load profiles." });
  const profiles = (allProfiles ?? []) as Array<{
    id: string;
    email: string | null;
    student_id: string | null;
    college_id: string | null;
    organization_id: string | null;
  }>;
  const profilesByStudent = new Map(
    profiles
      .filter((p) => p.student_id)
      .map((p) => [normalizeStudentId(p.student_id ?? ""), p]),
  );
  const deanByCollegeId = new Map(
    profiles.filter((p) => roleByUser.get(p.id) === "dean" && p.college_id).map((p) => [p.college_id as string, p]),
  );
  const adviserByOrgId = new Map(
    profiles
      .filter((p) => roleByUser.get(p.id) === "adviser" && p.organization_id)
      .map((p) => [p.organization_id as string, p]),
  );

  const studentIds = [
    ...new Set(
      incoming.map((r) => normalizeStudentId(String(r.student_id ?? ""))).filter((id) => STUDENT_ID_PATTERN.test(id)),
    ),
  ];
  const { data: studentRows, error: studentErr } =
    forcedRole === "student_officer" && studentIds.length
      ? await admin
          .from("students")
          .select("student_id, full_name, course, program, year_level, email, archived")
          .in("student_id", studentIds)
      : { data: [], error: null };
  if (studentErr) return json(500, { error: "Could not load student registry." });
  const students = new Map(
    ((studentRows ?? []) as Array<{
      student_id: string;
      full_name: string;
      course: string;
      program: string;
      year_level: string;
      email: string | null;
      archived: boolean;
    }>).map((s) => [normalizeStudentId(s.student_id), s]),
  );

  const seenStudent = new Set<string>();
  const seenEmail = new Set<string>();
  const seenCollege = new Set<string>();
  const seenOrg = new Set<string>();
  const classified: ClassifiedRow[] = [];

  for (const raw of incoming) {
    const row = Number(raw.row ?? 0);
    const studentId = normalizeStudentId(String(raw.student_id ?? ""));
    const fullName = String(raw.full_name ?? "").trim();
    const email = String(raw.email ?? "").trim().toLowerCase();
    const collegeName = String(raw.college ?? "").trim();
    const program = String(raw.program ?? "").trim();
    const yearLevel = String(raw.year_level ?? "").trim();
    const organization = String(raw.organization ?? "").trim();
    const position = String(raw.position ?? "").trim();
    const result: ClassifiedRow = {
      row,
      student_id: studentId,
      full_name: fullName,
      email,
      college: collegeName,
      organization: forcedRole === "adviser" ? program : organization,
      position,
      program,
      yearLevel,
      displayName: fullName,
      status: "Valid",
      message: `Ready to invite as ${label}.`,
    };

    if (isExampleRow(raw) || (!fullName && !email && !collegeName && !studentId)) continue;

    const sheetRole = String(raw.role ?? "").trim().toLowerCase();
    if (sheetRole && sheetRole !== forcedRole) {
      result.status = "Invalid";
      result.message = `The import can only create ${label} accounts.`;
    } else if (String(raw.password ?? "").trim()) {
      result.status = "Invalid";
      result.message = "Do not include passwords in the spreadsheet.";
    } else if (!fullName) {
      result.status = "Invalid";
      result.message = "Full name is required.";
    } else if (!emailMeetsAdminPolicy(email, requireIsuEmail)) {
      result.status = "Invalid";
      result.message = requireIsuEmail ? ISU_EMAIL_ERROR : "Enter a valid email address.";
    } else if (!collegeName) {
      result.status = "Invalid";
      result.message = "College is required.";
    } else if (forcedRole === "student_officer" && !organization) {
      result.status = "Invalid";
      result.message = "Organization is required.";
    } else if (forcedRole === "adviser" && !program) {
      result.status = "Invalid";
      result.message = "Program is required.";
    } else if (forcedRole === "student_officer" && !studentId) {
      result.status = "Invalid";
      result.message = "Student ID is required.";
    } else if (forcedRole === "student_officer" && !STUDENT_ID_PATTERN.test(studentId)) {
      result.status = "Invalid";
      result.message = "Student ID must look like 23-0668.";
    } else if (forcedRole === "student_officer" && !program) {
      result.status = "Invalid";
      result.message = "Program is required.";
    } else if (forcedRole === "student_officer" && !yearLevel) {
      result.status = "Invalid";
      result.message = "Year level is required.";
    } else if (!position) {
      result.status = "Invalid";
      result.message = "Position is required.";
    } else if (forcedRole === "student_officer" && seenStudent.has(studentId)) {
      result.status = "Invalid";
      result.message = `Duplicate row: student ID ${studentId} appears more than once in this file.`;
    } else if (seenEmail.has(email)) {
      result.status = "Invalid";
      result.message = `Duplicate row: email ${email} appears more than once in this file.`;
    } else {
      seenEmail.add(email);
      if (forcedRole === "student_officer") seenStudent.add(studentId);

      const collegeMatches = matchCollege(colleges, collegeName);
      if (collegeMatches.length === 0) {
        result.status = "Invalid";
        result.message = `College "${collegeName}" was not found.`;
      } else if (collegeMatches.length > 1) {
        result.status = "Invalid";
        result.message = `Multiple colleges match "${collegeName}". Rename duplicates in Admin first.`;
      } else {
        const college = collegeMatches[0]!;
        result.collegeId = college.id;

        if (forcedRole === "adviser") {
          const programMatches = programs.filter(
            (item) =>
              item.college_id === college.id &&
              item.name.trim().toLowerCase() === program.trim().toLowerCase(),
          );
          if (programMatches.length === 0) {
            result.status = "Invalid";
            result.message = `Program "${program}" was not found under "${college.name}".`;
          } else if (programMatches.length > 1) {
            result.status = "Invalid";
            result.message = `Multiple programs match "${program}" in "${college.name}".`;
          } else {
            result.programId = programMatches[0]!.id;
            result.status = "Valid";
            result.message = `Will invite this user as Adviser of ${programMatches[0]!.name}.`;
          }
        } else if (forcedRole === "dean") {
          if (seenCollege.has(college.id)) {
            result.status = "Invalid";
            result.message = `Duplicate row: college "${college.name}" already has a Dean in this file.`;
          } else if (deanByCollegeId.has(college.id)) {
            result.status = "Duplicate";
            result.message = `College "${college.name}" already has a registered Dean.`;
          } else {
            seenCollege.add(college.id);
            result.status = "Valid";
            result.message = `Will invite this user as Dean of ${college.name}.`;
          }
        } else {
          const { orgMatches, orgInOtherCollege } = matchOrg(orgs, college.id, organization);
          if (orgMatches.length === 0 && orgInOtherCollege) {
            result.status = "Invalid";
            result.message = `Organization "${organization}" does not belong to the selected college.`;
          } else if (orgMatches.length === 0) {
            result.status = "Invalid";
            result.message = `Organization "${organization}" was not found under "${college.name}".`;
          } else if (orgMatches.length > 1) {
            result.status = "Invalid";
            result.message = `Multiple organizations match "${organization}" in "${college.name}".`;
          } else {
            const org = orgMatches[0]!;
            result.organizationId = org.id;
            if (forcedRole === "adviser") {
              if (seenOrg.has(org.id)) {
                result.status = "Invalid";
                result.message = `Duplicate row: organization "${org.name}" already has an Adviser in this file.`;
              } else if (adviserByOrgId.has(org.id)) {
                result.status = "Duplicate";
                result.message = `Organization "${org.name}" already has a registered Adviser.`;
              } else {
                seenOrg.add(org.id);
                result.status = "Valid";
                result.message = `Will invite this user as Adviser of ${org.name}.`;
              }
            } else {
              const registry = students.get(studentId);
              if (registry?.archived) {
                result.status = "Invalid";
                result.message = `Student ID ${studentId} is archived in the registry.`;
              } else {
                result.displayName = registry?.full_name || fullName;
                const assigned = profilesByStudent.get(studentId);
                const assignedRole = assigned ? roleByUser.get(assigned.id) : undefined;
                if (assignedRole === "student_officer") {
                  result.status = "Duplicate";
                  result.message = `Student ID ${studentId} is already assigned to a Student Officer.`;
                } else if (assignedRole) {
                  result.status = "Invalid";
                  result.message = `Student ID ${studentId} already belongs to a ${assignedRole} account.`;
                } else if (!registry) {
                  result.createStudent = true;
                  result.status = "Valid";
                  result.message = "Will create the Student Officer account and add this student to the registry.";
                } else {
                  const mismatches: string[] = [];
                  if (registry.full_name.trim().toLowerCase() !== fullName.toLowerCase()) mismatches.push("name");
                  if (program && registry.program.trim().toLowerCase() !== program.toLowerCase()) mismatches.push("program");
                  if (yearLevel && registry.year_level.trim().toLowerCase() !== yearLevel.toLowerCase()) {
                    mismatches.push("year level");
                  }
                  if (mismatches.length) {
                    result.status = "Warning";
                    result.message = `Student is in the registry. Spreadsheet ${mismatches.join(", ")} differs from the registry and will not be overwritten.`;
                  } else {
                    result.status = "Valid";
                    result.message = "Student exists and will be invited as Student Officer.";
                  }
                }
              }
            }
          }
        }
      }
    }

    classified.push(result);
  }

  const toProvision = classified.filter((r) => r.status === "Valid" || r.status === "Warning");
  const results: RowResult[] = classified.map((r) => ({
    row: r.row,
    student_id: r.student_id,
    full_name: r.full_name,
    email: r.email,
    college: r.college,
    organization: r.organization,
    position: r.position,
    status: r.status,
    message: r.message,
  }));

  const redirectTo = inviteRedirect();
  let successful = 0;
  let failed = 0;
  let invitations = 0;

  for (const item of toProvision) {
    const index = results.findIndex((r) => r.row === item.row && r.email === item.email);
    try {
      if (await emailAlreadyRegistered(admin, item.email)) {
        if (index >= 0) {
          results[index] = {
            ...results[index]!,
            status: "Duplicate",
            message: "Email already belongs to an existing EventLink account.",
          };
        }
        continue;
      }

      if (item.createStudent) {
        const { error: studentInsertErr } = await admin.from("students").insert({
          student_id: item.student_id,
          full_name: item.full_name,
          course: item.college,
          program: item.program ?? "",
          year_level: item.yearLevel ?? "",
          email: item.email,
          college_id: item.collegeId ?? null,
          archived: false,
        });
        if (studentInsertErr) {
          console.error("[admin-bulk-provision] students", studentInsertErr);
          failed += 1;
          if (index >= 0) {
            results[index] = {
              ...results[index]!,
              status: "Failed",
              message: "Could not create the student registry row. The account was not created.",
            };
          }
          continue;
        }
      }

      const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(item.email, {
        data: {
          display_name: item.displayName || item.full_name,
          student_id: forcedRole === "student_officer" ? item.student_id : undefined,
          portal_role: forcedRole,
        },
        redirectTo,
      });
      if (inviteErr || !invited.user) {
        console.error("[admin-bulk-provision] invite", inviteErr);
        failed += 1;
        if (index >= 0) {
          results[index] = {
            ...results[index]!,
            status: "Failed",
            message: "Could not send the invitation. The account was not created.",
          };
        }
        continue;
      }

      const userId = invited.user.id;
      invitations += 1;
      const { error: roleUpsertErr } = await admin
        .from("user_roles")
        .upsert({ user_id: userId, role: forcedRole }, { onConflict: "user_id" });
      if (roleUpsertErr) {
        console.error("[admin-bulk-provision] user_roles", roleUpsertErr);
        await admin.auth.admin.deleteUser(userId);
        failed += 1;
        if (index >= 0) {
          results[index] = { ...results[index]!, status: "Failed", message: "Role could not be assigned. The invitation was cancelled." };
        }
        continue;
      }

      const { error: profileErr } = await admin.from("profiles").upsert(
        {
          id: userId,
          display_name: item.displayName || item.full_name,
          email: item.email,
          student_id: forcedRole === "student_officer" ? item.student_id : null,
          college_id: item.collegeId ?? null,
          program_id: forcedRole === "adviser" ? item.programId ?? null : null,
          organization_id: forcedRole === "student_officer" ? item.organizationId ?? null : null,
          position: item.position,
        },
        { onConflict: "id" },
      );
      if (profileErr) {
        console.error("[admin-bulk-provision] profiles", profileErr);
        await admin.from("user_roles").delete().eq("user_id", userId);
        await admin.auth.admin.deleteUser(userId);
        failed += 1;
        if (index >= 0) {
          results[index] = { ...results[index]!, status: "Failed", message: "Profile could not be saved. The invitation was cancelled." };
        }
        continue;
      }

      successful += 1;
      if (index >= 0) {
        results[index] = {
          ...results[index]!,
          status: "Success",
          message: `Invitation sent. The ${label.toLowerCase()} will set their own password.`,
        };
      }
    } catch (error) {
      console.error("[admin-bulk-provision] row", item.row, error);
      failed += 1;
      if (index >= 0) {
        results[index] = { ...results[index]!, status: "Failed", message: "This row could not be imported." };
      }
    }
  }

  const skipped = results.filter((r) => r.status === "Invalid" || r.status === "Duplicate").length;

  return json(200, {
    ok: true,
    role: forcedRole,
    total: results.length,
    successful,
    failed,
    skipped,
    invitations,
    rows: results,
  });
});
