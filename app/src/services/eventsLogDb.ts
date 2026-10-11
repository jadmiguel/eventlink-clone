import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import type { AnalyticsScopeOptions } from "@/services/analyticsDb";
import { stepLabel } from "@/services/eventRequestWorkflow";
import { useAuthStore } from "@/stores/auth";
import { appRoleLabel, type AppRole } from "@/types/appRole";
import type { DbWorkflowStep } from "@/types/eventRequest";

export type EventsLogScope = AnalyticsScopeOptions & {
  role: AppRole;
};

export type EventsLogFilters = {
  dateFrom?: string | null;
  dateTo?: string | null;
  organizationId?: string | null;
  collegeId?: string | null;
  status?: string | null;
  action?: string | null;
  venue?: string | null;
  office?: string | null;
};

export type EventsLogEntry = {
  id: string;
  requestId: string;
  eventName: string;
  organizationId: string | null;
  organizationName: string;
  collegeId: string | null;
  collegeName: string;
  venue: string;
  requestStatus: string;
  requestStatusRaw: string;
  action: string;
  actionLabel: string;
  previousStatus: string | null;
  newStatus: string | null;
  actorName: string;
  actorRole: string | null;
  actorRoleLabel: string;
  office: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type EventTrailEntry = EventsLogEntry;

export type RecentEventOption = {
  id: string;
  activity: string;
  organizationName: string;
  venue: string;
  status: string;
  updatedAt: string;
};

type ResourceOffice = "gso" | "it_infrastructure" | "sports_office";

type HistoryRow = {
  id: string;
  request_id: string;
  actor_id: string | null;
  action: string;
  step: DbWorkflowStep | null;
  comment: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  profiles?: { display_name: string | null } | { display_name: string | null }[] | null;
  event_requests?:
    | {
        id: string;
        activity: string;
        venue: string;
        status: string;
        organization_id: string | null;
        current_step: DbWorkflowStep | null;
        request_type: string;
        submitted_by: string;
        organizations?:
          | { name: string | null; college_id: string | null }
          | { name: string | null; college_id: string | null }[]
          | null;
      }
    | {
        id: string;
        activity: string;
        venue: string;
        status: string;
        organization_id: string | null;
        current_step: DbWorkflowStep | null;
        request_type: string;
        submitted_by: string;
        organizations?:
          | { name: string | null; college_id: string | null }
          | { name: string | null; college_id: string | null }[]
          | null;
      }[]
    | null;
};

type RequestRow = {
  id: string;
  activity: string;
  venue: string;
  status: string;
  organization_id: string | null;
  current_step: DbWorkflowStep | null;
  request_type: string;
  submitted_by: string;
  updated_at?: string;
  created_at: string;
  organizations?:
    | { name: string | null; college_id: string | null }
    | { name: string | null; college_id: string | null }[]
    | null;
};

type EventLogProjectionRow = {
  id: string;
  request_id: string;
  event_name: string;
  organization_id: string | null;
  organization_name: string;
  college_id: string | null;
  college_name: string;
  venue: string;
  request_status: string;
  action: string;
  step: string | null;
  comment: string | null;
  metadata: Record<string, unknown> | null;
  actor_id: string | null;
  actor_name: string;
  actor_role: string | null;
  office: string | null;
  created_at: string;
};

const HISTORY_SELECT = `
  id, request_id, actor_id, action, step, comment, metadata, created_at,
  event_requests (
    id, activity, venue, status, organization_id, current_step, request_type, submitted_by,
    organizations ( name, college_id )
  )
`;

const HISTORY_SELECT_FALLBACK = `
  id, request_id, actor_id, action, step, comment, created_at,
  event_requests (
    id, activity, venue, status, organization_id, current_step, request_type, submitted_by,
    organizations ( name, college_id )
  )
`;

const HISTORY_SELECT_PLAIN = `id, request_id, actor_id, action, step, comment, metadata, created_at`;
const HISTORY_SELECT_PLAIN_FALLBACK = `id, request_id, actor_id, action, step, comment, created_at`;

function asError(error: { message?: string } | null | undefined, fallback = "Could not load events log."): Error {
  return new Error(error?.message?.trim() || fallback);
}

async function hydrateHistoryWithRequests(rows: HistoryRow[]): Promise<HistoryRow[]> {
  const requestIds = [...new Set(rows.map((r) => r.request_id).filter(Boolean))];
  if (!requestIds.length) return rows;

  const supabase = getSupabase();
  const withOrgs = await supabase
    .from("event_requests")
    .select(
      "id, activity, venue, status, organization_id, current_step, request_type, submitted_by, organizations ( name, college_id )",
    )
    .in("id", requestIds);

  let requestRows: RequestRow[] = [];
  if (!withOrgs.error) {
    requestRows = (withOrgs.data ?? []) as RequestRow[];
  } else {
    const plain = await supabase
      .from("event_requests")
      .select("id, activity, venue, status, organization_id, current_step, request_type, submitted_by")
      .in("id", requestIds);
    if (plain.error) throw asError(plain.error);
    requestRows = (plain.data ?? []) as RequestRow[];
  }

  const byId = new Map(requestRows.map((r) => [r.id, r] as const));

  return rows.map((row) => ({
    ...row,
    event_requests: byId.get(row.request_id) ?? null,
  }));
}

const ACTION_LABELS: Record<string, string> = {
  created: "Created",
  submitted: "Submitted",
  approved: "Approved",
  forwarded: "Forwarded",
  scheduled: "Scheduled",
  declined: "Declined",
  posted: "Published",
  calendar_posted: "Posted",
  unposted: "Unposted",
  cancelled: "Cancelled",
  deleted: "Deleted",
  revision_requested: "Revision Requested",
  updated: "Edited",
  resubmitted: "Resubmitted",
  venue_assigned: "Venue Assigned",
  venue_approved: "Venue Approved",
  venue_declined: "Venue Declined",
  equipment_assigned: "Equipment Assigned",
  equipment_approved: "Equipment Approved",
  equipment_declined: "Equipment Declined",
  date_changed: "Date Changed",
  time_changed: "Time Changed",
  venue_changed: "Venue Changed",
  description_changed: "Description Changed",
  resource_approved: "Resource Approved",
  resource_declined: "Resource Declined",
  moved: "Moved",
  rescheduled: "Rescheduled",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  declined: "Declined",
  posted: "Posted",
  cancelled: "Cancelled",
  revision_requested: "Revision Requested",
};

function isResourceOfficeScope(scope: AppRole): scope is ResourceOffice {
  return scope === "gso" || scope === "it_infrastructure" || scope === "sports_office";
}

function unwrapProfile(
  profiles: HistoryRow["profiles"],
): { display_name: string | null } | null {
  if (!profiles) return null;
  return Array.isArray(profiles) ? (profiles[0] ?? null) : profiles;
}

function unwrapRequest(row: HistoryRow): RequestRow | null {
  const raw = row.event_requests;
  if (!raw) return null;
  const req = Array.isArray(raw) ? raw[0] : raw;
  if (!req) return null;
  return req as RequestRow;
}

function unwrapOrg(
  orgs: RequestRow["organizations"],
): { name: string | null; college_id: string | null } | null {
  if (!orgs) return null;
  return Array.isArray(orgs) ? (orgs[0] ?? null) : orgs;
}

function statusLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

function metadataString(meta: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const val = meta[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

function extractStatusFromMetadata(meta: Record<string, unknown>): {
  previousStatus: string | null;
  newStatus: string | null;
} {
  const prev =
    metadataString(meta, "previous_status", "prev_status", "old_status", "status_from", "from_status") ??
    null;
  const next =
    metadataString(meta, "new_status", "next_status", "status_to", "to_status") ?? null;
  return {
    previousStatus: prev ? statusLabel(prev) : null,
    newStatus: next ? statusLabel(next) : null,
  };
}

function officeFromStep(step: DbWorkflowStep | null): string | null {
  if (!step) return null;
  return stepLabel(step);
}

function officeFromMetadata(
  step: DbWorkflowStep | null,
  metadata: Record<string, unknown>,
): string | null {
  const fromMeta =
    (typeof metadata.office === "string" && metadata.office.trim()) ||
    (typeof metadata.assigned_office === "string" && metadata.assigned_office.trim()) ||
    null;
  if (fromMeta) {
    const labels: Record<string, string> = {
      gso: "GSO",
      sports_office: "Sports Office",
      it_infrastructure: "IT Infrastructure",
      ssc: "SSC",
      eo: "Executive Officer",
      osas: "OSAS",
      adviser: "Adviser",
      dean: "Dean",
      student_officer: "Student Officer",
      infirmary: "Infirmary",
      nstp: "NSTP",
    };
    return labels[fromMeta] ?? fromMeta;
  }
  return officeFromStep(step);
}

function refineActionLabel(
  action: string,
  step: DbWorkflowStep | null,
  comment: string | null,
  metadata: Record<string, unknown>,
): string {
  const base = ACTION_LABELS[action] ?? action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  if (action === "submitted" && metadata.is_resubmit !== true) {
    return "Submitted";
  }
  if (action === "created") return "Created";

  if (action === "venue_assigned" || action === "equipment_assigned") {
    const office = officeFromMetadata(step, metadata);
    return office ? `Forwarded to ${office}` : base;
  }

  if (action === "approved" && step === "resource_offices") {
    const lower = (comment ?? "").toLowerCase();
    if (lower.includes("sports office") || lower.includes("venue")) return "Venue Approved";
    if (lower.includes("it infrastructure") || lower.includes("equipment")) return "Equipment Approved";
    if (lower.includes("gso")) return "GSO Approved";
    return "Resource Approved";
  }

  if (action === "updated") {
    const hasScheduleChange =
      metadataString(metadata, "old_venue", "previous_venue", "old_start_date", "previous_start_date") ||
      metadataString(metadata, "new_venue", "venue", "new_start_date", "start_date");
    if (hasScheduleChange) return "Rescheduled";
    return "Edited";
  }

  if (action === "scheduled") return "Scheduled";
  if (action === "forwarded") return "Forwarded";
  if (action === "calendar_posted") return "Calendar Posted";

  return base;
}

async function fetchResourceOfficeRequestIds(office: ResourceOffice): Promise<string[]> {
  const supabase = getSupabase();
  let assignmentQuery = supabase
    .from("event_request_resource_assignments")
    .select("request_id")
    .eq("assigned_office", office);

  if (office === "it_infrastructure") {
    assignmentQuery = assignmentQuery.eq("resource_kind", "equipment");
  } else if (office === "sports_office") {
    assignmentQuery = assignmentQuery.eq("resource_kind", "venue");
  }

  const { data: assignmentRows, error: assignmentErr } = await assignmentQuery.limit(500);
  if (assignmentErr) throw asError(assignmentErr, "Could not load resource office assignments.");

  const ids = new Set<string>(
    ((assignmentRows ?? []) as Array<{ request_id: string | null }>)
      .map((r) => r.request_id)
      .filter((id): id is string => !!id),
  );

  if (office === "gso") {
    const since = new Date();
    since.setFullYear(since.getFullYear() - 1);
    const { data: legacyRows, error: legacyErr } = await supabase
      .from("event_requests")
      .select("id")
      .eq("current_step", "gso")
      .gte("created_at", since.toISOString())
      .limit(500);
    if (legacyErr) throw asError(legacyErr, "Could not load legacy GSO requests.");
    for (const row of (legacyRows ?? []) as Array<{ id: string }>) {
      if (row.id) ids.add(row.id);
    }
  }

  return [...ids];
}

async function fetchScopedRequestIds(scope: EventsLogScope): Promise<string[] | null> {
  const collegeId = scope.collegeId?.trim() || null;
  const programId = scope.programId?.trim() || null;
  const organizationId = scope.organizationId?.trim() || null;
  const userId = scope.userId?.trim() || null;

  if (scope.role === "dean" && !collegeId) return [];
  if (scope.role === "adviser" && !programId && !organizationId) return [];
  if (scope.role === "student_officer" && !organizationId && !userId) return [];

  if (
    scope.role === "eo" ||
    scope.role === "osas" ||
    scope.role === "admin"
  ) {
    return null;
  }

  if (scope.role === "infirmary" || scope.role === "nstp") {
    const supabase = getSupabase();
    const since = new Date();
    since.setFullYear(since.getFullYear() - 1);
    const { data, error } = await supabase
      .from("event_requests")
      .select("id")
      .not("calendar_posted_at", "is", null)
      .is("deleted_at", null)
      .gte("created_at", since.toISOString())
      .order("updated_at", { ascending: false })
      .limit(500);
    if (error) throw asError(error, "Could not load scheduled events.");
    return ((data ?? []) as Array<{ id: string }>).map((r) => r.id).filter(Boolean);
  }

  const supabase = getSupabase();
  const since = new Date();
  since.setFullYear(since.getFullYear() - 1);
  const sinceIso = since.toISOString();

  const useInnerOrg = scope.role === "dean" || (scope.role === "adviser" && !!programId);
  const orgSelect = useInnerOrg
    ? "organizations!inner(name, college_id, program_id)"
    : "organizations(name, college_id, program_id)";

  let query = supabase
    .from("event_requests")
    .select(`id, ${orgSelect}`)
    .gte("created_at", sinceIso)
    .order("updated_at", { ascending: false })
    .limit(500);

  if (scope.role === "ssc") {
    query = query.eq("request_type", "ssc");
  } else if (scope.role === "student_officer") {
    query = query.eq("request_type", "student_officer");
    if (organizationId) query = query.eq("organization_id", organizationId);
    else if (userId) query = query.eq("submitted_by", userId);
  } else if (scope.role === "dean") {
    query = query.eq("organizations.college_id", collegeId!);
  } else if (scope.role === "adviser") {
    if (programId) query = query.eq("organizations.program_id", programId);
    else if (organizationId) query = query.eq("organization_id", organizationId);
  } else if (isResourceOfficeScope(scope.role)) {
    return fetchResourceOfficeRequestIds(scope.role);
  }

  const { data, error } = await query;
  if (error) throw asError(error, "Could not load scoped event requests.");
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id).filter(Boolean);
}

async function fetchCollegeNameMap(): Promise<Map<string, string>> {
  const supabase = getSupabase();
  const { data } = await supabase.from("colleges").select("id, name");
  return new Map(
    ((data ?? []) as Array<{ id: string; name: string | null }>).map((c) => [
      c.id,
      c.name?.trim() || "College",
    ]),
  );
}

async function fetchActorRoleMap(actorIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(actorIds.filter(Boolean))];
  if (!unique.length) return new Map();
  const supabase = getSupabase();
  const { data, error } = await supabase.from("user_roles").select("user_id, role").in("user_id", unique);
  if (error) {
    console.warn("[eventsLog] user_roles lookup failed", error.message);
    return new Map();
  }
  return new Map(
    ((data ?? []) as Array<{ user_id: string; role: string }>).map((r) => [r.user_id, r.role]),
  );
}

async function fetchActorNameMap(actorIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(actorIds.filter(Boolean))];
  if (!unique.length) return new Map();
  const supabase = getSupabase();
  const { data, error } = await supabase.from("profiles").select("id, display_name").in("id", unique);
  if (error) {
    console.warn("[eventsLog] profiles lookup failed", error.message);
    return new Map();
  }
  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id: string; display_name: string | null }>) {
    const name = row.display_name?.trim();
    if (name) map.set(row.id, name);
  }
  return map;
}

function mapHistoryRow(
  row: HistoryRow,
  collegeNameById: Map<string, string>,
  actorRoleById: Map<string, string>,
  actorNameById: Map<string, string>,
): EventsLogEntry | null {
  const req = unwrapRequest(row);
  if (!req) return null;

  const org = unwrapOrg(req.organizations);
  const orgName = org?.name?.trim() || "Organization";
  const collegeName = org?.college_id
    ? (collegeNameById.get(org.college_id) ?? "Unassigned College")
    : "Unassigned College";

  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const { previousStatus, newStatus } = extractStatusFromMetadata(metadata);
  const actorRole = row.actor_id ? (actorRoleById.get(row.actor_id) ?? null) : null;
  const actorName =
    (row.actor_id ? actorNameById.get(row.actor_id) : null) ||
    unwrapProfile(row.profiles)?.display_name?.trim() ||
    "System";

  return {
    id: row.id,
    requestId: row.request_id,
    eventName: req.activity?.trim() || "Untitled event",
    organizationId: req.organization_id,
    organizationName: orgName,
    collegeId: org?.college_id ?? null,
    collegeName,
    venue: req.venue?.trim() || "—",
    requestStatus: statusLabel(req.status) ?? req.status,
    requestStatusRaw: req.status,
    action: row.action,
    actionLabel: refineActionLabel(row.action, row.step, row.comment, metadata),
    previousStatus,
    newStatus,
    actorName,
    actorRole,
    actorRoleLabel: actorRole
      ? appRoleLabel(actorRole as AppRole) || actorRole.replace(/_/g, " ")
      : "—",
    office:
      officeFromMetadata(row.step, metadata) ??
      (actorRole ? appRoleLabel(actorRole as AppRole) || actorRole.replace(/_/g, " ") : null),
    notes: row.comment?.trim() || null,
    metadata,
    createdAt: row.created_at,
  };
}

function mapEventLogProjection(row: EventLogProjectionRow): EventsLogEntry {
  const metadata = row.metadata ?? {};
  const step = row.step as DbWorkflowStep | null;
  const { previousStatus, newStatus } = extractStatusFromMetadata(metadata);
  const actorRole = row.actor_role;
  return {
    id: row.id,
    requestId: row.request_id,
    eventName: row.event_name?.trim() || "Untitled event",
    organizationId: row.organization_id,
    organizationName: row.organization_name?.trim() || "Organization",
    collegeId: row.college_id,
    collegeName: row.college_name?.trim() || "Unassigned College",
    venue: row.venue?.trim() || "—",
    requestStatus: statusLabel(row.request_status) ?? row.request_status,
    requestStatusRaw: row.request_status,
    action: row.action,
    actionLabel: refineActionLabel(row.action, step, row.comment, metadata),
    previousStatus,
    newStatus,
    actorName: row.actor_name?.trim() || "System",
    actorRole,
    actorRoleLabel: actorRole
      ? appRoleLabel(actorRole as AppRole) || actorRole.replace(/_/g, " ")
      : "—",
    office: officeFromMetadata(step, { ...metadata, office: row.office }),
    notes: row.comment?.trim() || null,
    metadata,
    createdAt: row.created_at,
  };
}

export function appRoleToEventsLogScope(role: AppRole): AppRole | null {
  return role === "eo" ? "eo" : null;
}

function assertEoEventLogAccess(scopeRole?: AppRole) {
  const auth = useAuthStore();
  if (auth.appRole !== "eo" || (scopeRole && scopeRole !== "eo")) {
    throw new Error("You are not authorized to view the Event Log.");
  }
}

export async function fetchEventsLog(
  filters: EventsLogFilters,
  scope: EventsLogScope,
  pagination?: { page?: number; pageSize?: number },
): Promise<import("@/types/pagination").PaginatedResult<EventsLogEntry>> {
  const { buildPaginatedResult, emptyPage, pageToRange } = await import("@/types/pagination");
  if (!isSupabaseConfigured) return emptyPage();
  assertEoEventLogAccess(scope.role);

  const { page, pageSize } = pageToRange(pagination?.page, pagination?.pageSize);
  const { data, error } = await getSupabase().rpc("eo_event_log_page", {
    p_date_from: filters.dateFrom?.trim() || null,
    p_date_to: filters.dateTo?.trim() || null,
    p_organization_id: filters.organizationId?.trim() || null,
    p_college_id: filters.collegeId?.trim() || null,
    p_status: filters.status?.trim() || null,
    p_action: filters.action?.trim() || null,
    p_venue: filters.venue?.trim() || null,
    p_office: filters.office?.trim() || null,
    p_page: page,
    p_page_size: pageSize,
  });
  if (error) throw asError(error);

  const result = (data ?? {}) as {
    rows?: EventLogProjectionRow[];
    total?: number;
  };
  const entries = (result.rows ?? []).map(mapEventLogProjection);
  return buildPaginatedResult(entries, Number(result.total ?? 0), page, pageSize);
}

export async function fetchEventTrail(
  requestId: string,
  scope?: EventsLogScope,
  pagination?: { page?: number; pageSize?: number },
): Promise<import("@/types/pagination").PaginatedResult<EventTrailEntry>> {
  const { buildPaginatedResult, emptyPage, pageToRange } = await import("@/types/pagination");
  if (!isSupabaseConfigured) return emptyPage();
  assertEoEventLogAccess(scope?.role);
  const trimmed = requestId.trim();
  if (!trimmed) return emptyPage();

  if (scope) {
    const requestIds = await fetchScopedRequestIds(scope);
    if (requestIds !== null && !requestIds.includes(trimmed)) return emptyPage();
  }

  const { page, pageSize, from, to } = pageToRange(pagination?.page, pagination?.pageSize);
  const supabase = getSupabase();

  async function runTrailQuery(select: string) {
    return supabase
      .from("event_request_history")
      .select(select, { count: "exact" })
      .eq("request_id", trimmed)
      .order("created_at", { ascending: true })
      .range(from, to);
  }

  let { data, error, count } = await runTrailQuery(HISTORY_SELECT);
  let needsHydrate = false;

  if (error) {
    ({ data, error, count } = await runTrailQuery(HISTORY_SELECT_FALLBACK));
  }
  if (error) {
    ({ data, error, count } = await runTrailQuery(HISTORY_SELECT_PLAIN));
    needsHydrate = !error;
  }
  if (error) {
    ({ data, error, count } = await runTrailQuery(HISTORY_SELECT_PLAIN_FALLBACK));
    needsHydrate = !error;
  }
  if (error) throw asError(error);

  let rows = (data ?? []) as unknown as HistoryRow[];
  if (needsHydrate) {
    rows = await hydrateHistoryWithRequests(rows);
  }

  const actorIds = rows.map((r) => r.actor_id).filter(Boolean) as string[];
  const [collegeNameById, actorRoleById, actorNameById] = await Promise.all([
    fetchCollegeNameMap(),
    fetchActorRoleMap(actorIds),
    fetchActorNameMap(actorIds),
  ]);

  const entries = rows
    .map((row) => mapHistoryRow(row, collegeNameById, actorRoleById, actorNameById))
    .filter((e): e is EventTrailEntry => !!e);

  return buildPaginatedResult(entries, count ?? entries.length, page, pageSize);
}

export async function fetchRecentEventsInScope(scope: EventsLogScope): Promise<RecentEventOption[]> {
  if (!isSupabaseConfigured) return [];
  assertEoEventLogAccess(scope.role);

  const requestIds = await fetchScopedRequestIds(scope);
  if (requestIds !== null && requestIds.length === 0) return [];

  const supabase = getSupabase();
  let query = supabase
    .from("event_requests")
    .select("id, activity, venue, status, updated_at, created_at, organizations(name)")
    .order("updated_at", { ascending: false })
    .limit(40);

  if (requestIds !== null) {
    query = query.in("id", requestIds.slice(0, 40));
  }

  const { data, error } = await query;
  if (error) throw asError(error, "Could not load recent events.");

  return ((data ?? []) as RequestRow[]).map((row) => {
    const org = unwrapOrg(row.organizations);
    return {
      id: row.id,
      activity: row.activity?.trim() || "Untitled event",
      organizationName: org?.name?.trim() || "Organization",
      venue: row.venue?.trim() || "—",
      status: statusLabel(row.status) ?? row.status,
      updatedAt: row.updated_at ?? row.created_at,
    };
  });
}

export type EventTrailContext = {
  id: string;
  activity: string;
  organizationName: string;
  collegeName: string;
  requesterName: string;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  venue: string;
  status: string;
  currentStep: string | null;
  purpose: string;
  letterPath: string | null;
};

export async function fetchEventTrailContext(
  requestId: string,
  scope?: EventsLogScope,
): Promise<EventTrailContext | null> {
  if (!isSupabaseConfigured) return null;
  assertEoEventLogAccess(scope?.role);
  const trimmed = requestId.trim();
  if (!trimmed) return null;

  if (scope) {
    const requestIds = await fetchScopedRequestIds(scope);
    if (requestIds !== null && !requestIds.includes(trimmed)) return null;
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("event_requests")
    .select(
      "id, activity, venue, status, current_step, start_date, end_date, start_time, end_time, purpose, letter_path, submitted_by, organizations(name, college_id)",
    )
    .eq("id", trimmed)
    .maybeSingle();
  if (error) throw asError(error, "Could not load event details.");
  if (!data) return null;

  const org = unwrapOrg(
    (data as { organizations?: RequestRow["organizations"] }).organizations ?? null,
  );
  const [collegeNameById, actorNameById] = await Promise.all([
    fetchCollegeNameMap(),
    fetchActorNameMap(data.submitted_by ? [data.submitted_by as string] : []),
  ]);

  return {
    id: String(data.id),
    activity: String(data.activity ?? "").trim() || "Untitled event",
    organizationName: org?.name?.trim() || "—",
    collegeName: org?.college_id ? collegeNameById.get(org.college_id) ?? "—" : "—",
    requesterName: data.submitted_by ? actorNameById.get(String(data.submitted_by)) ?? "—" : "—",
    startDate: String(data.start_date ?? ""),
    endDate: String(data.end_date ?? ""),
    startTime: String(data.start_time ?? ""),
    endTime: String(data.end_time ?? ""),
    venue: String(data.venue ?? "").trim() || "—",
    status: statusLabel(String(data.status ?? "")) ?? String(data.status ?? "—"),
    currentStep: data.current_step ? stepLabel(data.current_step as DbWorkflowStep) : null,
    purpose: String(data.purpose ?? "").trim(),
    letterPath: (data.letter_path as string | null) ?? null,
  };
}

export const EVENT_LOG_ACTION_OPTIONS = Object.entries(ACTION_LABELS).map(([value, label]) => ({
  value,
  label,
}));

export const EVENT_LOG_STATUS_OPTIONS = Object.entries(STATUS_LABELS).map(([value, label]) => ({
  value,
  label,
}));

export const EVENT_LOG_OFFICE_OPTIONS: { value: string; label: string }[] = [
  { value: "adviser", label: "Adviser" },
  { value: "dean", label: "Dean" },
  { value: "osas", label: "OSAS" },
  { value: "eo", label: "Executive Officer" },
  { value: "gso", label: "GSO" },
  { value: "it", label: "IT Infrastructure" },
  { value: "sports", label: "Sports Office" },
  { value: "resource", label: "Resource Offices" },
];
