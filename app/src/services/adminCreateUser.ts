import { getSupabase } from "@/lib/supabase";

export type CreatePortalUserInput = {
  role:
    | "student_officer"
    | "ssc"
    | "adviser"
    | "dean"
    | "osas"
    | "eo"
    | "gso"
    | "it_infrastructure"
    | "sports_office"
    | "infirmary"
    | "nstp"
    | "admin";
  email: string;
  password: string;
  displayName: string;
  collegeId?: string | null;
  programId?: string | null;
  organizationId?: string | null;
};

export type UpdatePortalUserInput = {
  userId: string;
  role: CreatePortalUserInput["role"];
  email: string;
  displayName: string;
  password?: string;
  collegeId?: string | null;
  programId?: string | null;
  organizationId?: string | null;
};

export type CreatePortalUserResult = {
  userId: string;
  role: CreatePortalUserInput["role"];
  email: string;
};

export class AdminCreateUserError extends Error {
  readonly source: string;
  constructor(message: string, source = "unknown") {
    super(message);
    this.name = "AdminCreateUserError";
    this.source = source;
  }
}

async function invokeAdminCreateUser(body: Record<string, unknown>): Promise<CreatePortalUserResult> {
  const supabase = getSupabase();
  const { data, error } = await supabase.functions.invoke("admin-create-user", { body });

  const payload = data as
    | (Partial<CreatePortalUserResult> & { error?: string; source?: string })
    | null;

  if (payload?.error) {
    throw new AdminCreateUserError(payload.error, payload.source || "edge_function");
  }

  if (error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      const body = (await context
        .clone()
        .json()
        .catch(() => null)) as { error?: string; source?: string } | null;
      if (body?.error) {
        throw new AdminCreateUserError(body.error, body.source || "edge_function");
      }
    }
    const msg = error.message || "Could not save user account.";
    const lowered = msg.toLowerCase();
    if (
      lowered.includes("failed to send a request") ||
      lowered.includes("non-2xx") ||
      lowered.includes("not found")
    ) {
      throw new AdminCreateUserError(
        "Admin create-user function is not available. Deploy Supabase function: admin-create-user.",
        "edge_function",
      );
    }
    throw new AdminCreateUserError(msg, "edge_function");
  }

  if (!payload?.userId || !payload?.role || !payload?.email) {
    throw new AdminCreateUserError(
      "User account was created, but the response was invalid.",
      "edge_function",
    );
  }

  return {
    userId: payload.userId,
    role: payload.role,
    email: payload.email,
  };
}

export async function createPortalUser(input: CreatePortalUserInput): Promise<CreatePortalUserResult> {
  const email = input.email.trim();
  return invokeAdminCreateUser({
    role: input.role,
    email,
    password: input.password,
    displayName: input.displayName.trim(),
    collegeId: input.collegeId ?? null,
    programId: input.programId ?? null,
    organizationId: input.organizationId ?? null,
  });
}

export async function updatePortalUser(input: UpdatePortalUserInput): Promise<CreatePortalUserResult> {
  return invokeAdminCreateUser({
    userId: input.userId,
    role: input.role,
    email: input.email.trim(),
    password: input.password?.trim() || "",
    displayName: input.displayName.trim(),
    collegeId: input.collegeId ?? null,
    programId: input.programId ?? null,
    organizationId: input.organizationId ?? null,
  });
}
