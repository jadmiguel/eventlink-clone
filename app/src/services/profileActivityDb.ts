import { getSupabase } from "@/lib/supabase";
import { countPendingForRole } from "@/services/eventRequestsDb";
import type { AppRole } from "@/types/appRole";
import type { ActivityStatModel } from "@/types/portalProfile";

function makeStat(id: string, label: string, value: number, icon: ActivityStatModel["icon"]): ActivityStatModel {
  return { id, label, value: Math.max(0, Number(value || 0)), icon };
}

async function countScheduledForProfile(
  role: AppRole,
  userId: string,
  profile: { college_id: string | null; program_id: string | null; organization_id: string | null } | null,
): Promise<number> {
  const supabase = getSupabase();
  if (role === "gso" || role === "it_infrastructure" || role === "sports_office") {
    let query = supabase
      .from("event_request_resource_assignments")
      .select("request_id", { head: true, count: "exact" })
      .eq("assigned_office", role);
    if (role === "it_infrastructure") query = query.eq("resource_kind", "equipment");
    if (role === "sports_office") query = query.eq("resource_kind", "venue");
    const { count } = await query;
    return count ?? 0;
  }

  const needsProgramJoin = role === "adviser" && !!profile?.program_id;
  const needsCollegeJoin = role === "dean" && !!profile?.college_id;
  const select = needsProgramJoin
    ? "id, organizations!inner(program_id)"
    : needsCollegeJoin
      ? "id, organizations!inner(college_id)"
      : "id";
  let query = supabase
    .from("event_requests")
    .select(select, {
      head: true,
      count: "exact",
    })
    .not("calendar_posted_at", "is", null);

  if (role === "student_officer") {
    if (profile?.organization_id) query = query.eq("organization_id", profile.organization_id);
    else query = query.eq("submitted_by", userId);
  } else if (role === "ssc") {
    query = query.eq("request_type", "ssc");
  } else if (needsProgramJoin) {
    query = query.eq("organizations.program_id", profile!.program_id!);
  } else if (needsCollegeJoin) {
    query = query.eq("organizations.college_id", profile!.college_id!);
  } else if (role === "adviser" && profile?.organization_id) {
    query = query.eq("organization_id", profile.organization_id);
  }

  const { count } = await query;
  return count ?? 0;
}

export async function fetchProfileActivityStats(role: AppRole, userId: string): Promise<ActivityStatModel[]> {
  const supabase = getSupabase();

  if (role === "admin") {
    const [{ count: usersCount }, orgsRes, { count: eventsCount }] = await Promise.all([
      supabase.from("user_roles").select("user_id", { head: true, count: "exact" }),
      supabase.from("organizations").select("id"),
      supabase.from("event_requests").select("id", { head: true, count: "exact" }),
    ]);
    return [
      makeStat("users", "Managed users", usersCount ?? 0, "Users"),
      makeStat("orgs", "Active organizations", (orgsRes.data ?? []).length, "Building2"),
      makeStat("events", "Total events", eventsCount ?? 0, "LayoutDashboard"),
    ];
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("college_id, program_id, organization_id")
    .eq("id", userId)
    .maybeSingle();

  const [{ count: approvedCount }, pendingCount, scheduledCount] = await Promise.all([
    supabase
      .from("event_request_history")
      .select("id", { head: true, count: "exact" })
      .eq("actor_id", userId)
      .eq("action", "approved"),
    countPendingForRole(role, userId, {
      collegeId: profile?.college_id ?? null,
      programId: profile?.program_id ?? null,
      organizationId: profile?.organization_id ?? null,
    }),
    countScheduledForProfile(role, userId, profile),
  ]);

  return [
    makeStat("approved", "Approved requests", approvedCount ?? 0, "CheckCircle"),
    makeStat("pending", "Pending reviews", pendingCount, "Clock"),
    makeStat("scheduled", "Scheduled events", scheduledCount, "Calendar"),
  ];
}
