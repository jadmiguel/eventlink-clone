import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const validRoles = new Set([
  "student_officer",
  "ssc",
  "adviser",
  "dean",
  "osas",
  "eo",
  "gso",
  "it_infrastructure",
  "sports_office",
  "infirmary",
  "nstp",
  "admin",
]);

const ISU_EMAIL_DOMAIN = "isu.edu.ph";
const ISU_EMAIL_ERROR = "Please use a valid ISU email address.";

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

function emailPolicyError(requireIsuEmail: boolean): string {
  return requireIsuEmail ? ISU_EMAIL_ERROR : "Enter a valid email address.";
}

async function loadRequireIsuEmail(
  admin: ReturnType<typeof createClient>,
): Promise<{ ok: true; value: boolean } | { ok: false; response: Response }> {
  const { data, error } = await admin
    .from("app_settings")
    .select("require_isu_email")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    console.error("[admin-create-user] app_settings", error);
    return {
      ok: false,
      response: json(500, { error: "Could not load application settings.", source: "app_settings" }),
    };
  }
  return { ok: true, value: data?.require_isu_email === true };
}

const singletonRoles = new Set(["osas", "eo", "gso"]);

type CreateUserBody = {
  userId?: string;
  role?: string;
  email?: string;
  password?: string;
  displayName?: string;
  collegeId?: string | null;
  programId?: string | null;
  organizationId?: string | null;
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed." });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authHeader = req.headers.get("Authorization");
  const accessToken = authHeader?.replace("Bearer ", "").trim();

  if (!url || !serviceKey || !anonKey || !accessToken) {
    return json(500, { error: "Missing function configuration or auth token." });
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const authClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const {
    data: { user: requester },
    error: authErr,
  } = await authClient.auth.getUser();
  if (authErr || !requester) {
    return json(401, { error: "Unauthorized." });
  }

  const { data: roleRow, error: roleErr } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", requester.id)
    .maybeSingle();
  if (roleErr || roleRow?.role !== "admin") {
    return json(403, { error: "Only admin users can create portal accounts." });
  }

  let body: CreateUserBody;
  try {
    body = (await req.json()) as CreateUserBody;
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const role = String(body.role ?? "").trim().toLowerCase();
  const requestedUserId = String(body.userId ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const displayName = String(body.displayName ?? "").trim();
  const collegeId = String(body.collegeId ?? "").trim();
  const programId = String(body.programId ?? "").trim();
  const organizationId = String(body.organizationId ?? "").trim();

  if (!validRoles.has(role)) {
    return json(400, { error: "Invalid role selected.", source: "role_validation" });
  }
  if (!displayName) {
    return json(400, { error: "Display name is required.", source: "validation" });
  }

  const settings = await loadRequireIsuEmail(admin);
  if (!settings.ok) return settings.response;
  const requireIsuEmail = settings.value;

  if (!requestedUserId) {
    if (!emailMeetsAdminPolicy(email, requireIsuEmail)) {
      return json(400, { error: emailPolicyError(requireIsuEmail), source: "email_validation" });
    }
  }
  const needsCollege = role === "dean" || role === "adviser" || role === "student_officer";
  const needsProgram = role === "adviser" || role === "student_officer";
  const needsOrganization = role === "student_officer";
  if (needsCollege && !collegeId) {
    return json(400, { error: "College is required for this role." });
  }
  if (needsProgram && !programId) {
    return json(400, { error: "Program is required for this role." });
  }
  if (needsOrganization && !organizationId) {
    return json(400, { error: "Organization is required for this role." });
  }

  if (collegeId) {
    const { data: collegeRow, error: collegeErr } = await admin
      .from("colleges")
      .select("id")
      .eq("id", collegeId)
      .maybeSingle();
    if (collegeErr) return json(500, { error: collegeErr.message });
    if (!collegeRow) return json(400, { error: "Selected college was not found." });
  }

  if (programId) {
    const { data: programRow, error: programErr } = await admin
      .from("programs")
      .select("id, college_id")
      .eq("id", programId)
      .maybeSingle();
    if (programErr) return json(500, { error: programErr.message });
    if (!programRow) return json(400, { error: "Selected program was not found." });
    if (collegeId && programRow.college_id !== collegeId) {
      return json(400, { error: "Selected program does not belong to the selected college." });
    }
  }

  if (organizationId) {
    const { data: orgRow, error: orgErr } = await admin
      .from("organizations")
      .select("id, college_id, program_id")
      .eq("id", organizationId)
      .maybeSingle();
    if (orgErr) return json(500, { error: orgErr.message });
    if (!orgRow) return json(400, { error: "Selected organization was not found." });
    if (collegeId && orgRow.college_id !== collegeId) {
      return json(400, { error: "Selected organization does not belong to the selected college." });
    }
    if (needsOrganization && programId && orgRow.program_id !== programId) {
      return json(400, { error: "Selected organization does not belong to the selected program." });
    }
  }

  let existing: { id: string; email?: string | null } | null = null;

  if (requestedUserId) {
    const { data: existingById, error: byIdErr } = await admin.auth.admin.getUserById(requestedUserId);
    if (byIdErr) return json(500, { error: byIdErr.message });
    if (!existingById.user) return json(404, { error: "Target user not found." });
    existing = existingById.user;
  } else {
    if (!email || !email.includes("@")) {
      return json(400, { error: "A valid email is required." });
    }
    const { data: usersPage, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listErr) {
      return json(500, { error: listErr.message });
    }
    const taken = usersPage.users.some((u) => (u.email ?? "").toLowerCase() === email);
    if (taken) {
      return json(409, {
        error: "This email is already used by another account. Edit that user instead.",
        source: "email_validation",
      });
    }
  }

  if (!existing && password.length < 8) {
    return json(400, { error: "Password must be at least 8 characters." });
  }
  if (existing && password && password.length < 8) {
    return json(400, { error: "If provided, password must be at least 8 characters." });
  }

  const existingUserId = existing?.id ?? null;

  if (singletonRoles.has(role)) {
    let singletonQuery = admin.from("user_roles").select("user_id").eq("role", role).limit(1);
    if (existingUserId) {
      singletonQuery = singletonQuery.neq("user_id", existingUserId);
    }
    const { data: existingRole, error: singletonErr } = await singletonQuery.maybeSingle();
    if (singletonErr) {
      return json(500, { error: singletonErr.message });
    }
    if (existingRole?.user_id) {
      return json(409, { error: `Only one ${role.toUpperCase()} account is allowed.` });
    }
  }

  if (role === "dean" && collegeId) {
    const { data: deanRoles, error: deanRoleErr } = await admin
      .from("user_roles")
      .select("user_id")
      .eq("role", "dean");
    if (deanRoleErr) return json(500, { error: deanRoleErr.message });
    const deanIds = (deanRoles ?? [])
      .map((r) => r.user_id as string)
      .filter((id) => id && id !== existingUserId);
    if (deanIds.length) {
      const { data: existingDean, error: deanProfileErr } = await admin
        .from("profiles")
        .select("id, display_name")
        .in("id", deanIds)
        .eq("college_id", collegeId)
        .limit(1)
        .maybeSingle();
      if (deanProfileErr) return json(500, { error: deanProfileErr.message });
      if (existingDean?.id) {
        return json(409, { error: "This college already has a registered Dean." });
      }
    }
  }

  let userId = existing?.id ?? "";
  let createdNewAuthUser = false;
  if (!existing) {
    // email_confirm: true → account is immediately login-ready (no confirmation link).
    // Required for Admin-created / dummy test emails during development.
    const { data: createData, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName, portal_role: role },
    });
    if (createErr || !createData.user) {
      console.error("[admin-create-user] auth", createErr);
      return json(500, { error: createErr?.message ?? "Failed to create auth user.", source: "auth" });
    }
    userId = createData.user.id;
    createdNewAuthUser = true;
  } else {
    const effectiveEmail = email || (existing.email ?? "").toLowerCase();
    if (!effectiveEmail || !effectiveEmail.includes("@")) {
      return json(400, { error: "User email is missing or invalid." });
    }
    const updatePayload: {
      password?: string;
      email?: string;
      email_confirm: boolean;
      user_metadata: { display_name: string; portal_role: string };
    } = {
      email_confirm: true,
      user_metadata: { display_name: displayName, portal_role: role },
    };
    if (password) updatePayload.password = password;
    if (email && email !== (existing.email ?? "").toLowerCase()) {
      if (!emailMeetsAdminPolicy(email, requireIsuEmail)) {
        return json(400, { error: emailPolicyError(requireIsuEmail), source: "email_validation" });
      }
      updatePayload.email = email;
    }
    const { error: updateErr } = await admin.auth.admin.updateUserById(existing.id, updatePayload);
    if (updateErr) {
      console.error("[admin-create-user] auth update", updateErr);
      return json(500, { error: updateErr.message, source: "auth" });
    }
    userId = existing.id;
  }

  const finalEmail = email || ((existing?.email ?? "").toLowerCase());
  if (!finalEmail || !finalEmail.includes("@")) {
    return json(400, { error: "User email is missing or invalid." });
  }

  const { error: roleUpsertErr } = await admin
    .from("user_roles")
    .upsert({ user_id: userId, role }, { onConflict: "user_id" });
  if (roleUpsertErr) {
    console.error("[admin-create-user] user_roles", roleUpsertErr);
    if (createdNewAuthUser) {
      await admin.auth.admin.deleteUser(userId);
    }
    return json(500, { error: roleUpsertErr.message, source: "user_roles" });
  }

  const { error: profileUpsertErr } = await admin.from("profiles").upsert(
    {
      id: userId,
      display_name: displayName,
      email: finalEmail,
      college_id: needsCollege ? collegeId || null : null,
      program_id: needsProgram ? programId || null : null,
      organization_id: needsOrganization ? organizationId || null : null,
    },
    { onConflict: "id" },
  );
  if (profileUpsertErr) {
    console.error("[admin-create-user] profiles", profileUpsertErr);
    if (createdNewAuthUser) {
      await admin.from("user_roles").delete().eq("user_id", userId);
      await admin.auth.admin.deleteUser(userId);
    }
    return json(500, { error: profileUpsertErr.message, source: "profiles" });
  }

  return json(200, {
    userId,
    role,
    email: finalEmail,
  });
});
