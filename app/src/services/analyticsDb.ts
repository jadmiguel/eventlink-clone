import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { countPendingForRole } from "@/services/eventRequestsDb";
import { parseSdgsFromStorage, sdgLabel } from "@/constants/sdgs";
import type { AppRole } from "@/types/appRole";

export type AnalyticsScope =
  | "ssc"
  | "student_officer"
  | "eo"
  | "adviser"
  | "dean"
  | "osas"
  | "gso"
  | "it_infrastructure"
  | "sports_office";

export type AnalyticsPeriod = {
  year: number;
  /** 1–12 */
  month: number;
};

export type AnalyticsScopeOptions = {
  /** profiles.college_id — required for dean */
  collegeId?: string | null;
  /** profiles.program_id — required for adviser */
  programId?: string | null;
  /** profiles.organization_id — required for student_officer (preferred) */
  organizationId?: string | null;
  /** auth user id — fallback for student_officer when org is missing */
  userId?: string | null;
  /** Selected calendar month. Cards, pie, and records use this month; the trend uses the prior 6 months. */
  period?: AnalyticsPeriod | null;
};

export type AnalyticsEventRecord = {
  id: string;
  activity: string;
  status: "Approved" | "Pending" | "Rejected";
  org: string;
  college: string;
  createdAt: string;
  sdgIds: number[];
};

type RequestRow = {
  id: string;
  activity: string;
  status: "pending" | "approved" | "declined" | "posted";
  current_step: string | null;
  created_at: string;
  sdgs?: string | null;
  organizations?:
    | { name: string | null; college_id?: string | null }[]
    | { name: string | null; college_id?: string | null }
    | null;
};

export type MonthlyPoint = {
  id: string;
  month: string;
  events: number;
  approved: number;
  rejected: number;
};

export type StatusSlice = {
  name: "Approved" | "Pending" | "Rejected";
  value: number;
  color: string;
};

export type ActivityItem = {
  id: number;
  action: "Approved" | "Rejected" | "Pending";
  event: string;
  time: string;
  org: string;
  icon: string;
};

export type StatTotals = {
  totalThisYear: number;
  approvedThisMonth: number;
  approvedLastMonth: number;
  pendingCount: number;
  awaitingPublishCount: number;
  allTimeCount: number;
};

export type OrganizationPoint = { org: string; events: number };
export type CollegePoint = { college: string; events: number };
export type SdgUsagePoint = { id: number; name: string; value: number; color: string };

export type AnalyticsOverview = {
  monthlyEvents: MonthlyPoint[];
  eventStatusData: StatusSlice[];
  recentActivity: ActivityItem[];
  organizationData: OrganizationPoint[];
  collegeData: CollegePoint[];
  sdgUsage: SdgUsagePoint[];
  records: AnalyticsEventRecord[];
  totals: StatTotals;
  peakMonthLabel: string;
};

export function currentAnalyticsPeriod(from = new Date()): AnalyticsPeriod {
  return { year: from.getFullYear(), month: from.getMonth() + 1 };
}

export function analyticsPeriodLabel(period: AnalyticsPeriod): string {
  return new Date(period.year, period.month - 1, 1).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
}

export function shiftAnalyticsPeriod(period: AnalyticsPeriod, deltaMonths: number): AnalyticsPeriod {
  const d = new Date(period.year, period.month - 1 + deltaMonths, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

export function isAnalyticsPeriodInFuture(period: AnalyticsPeriod, now = new Date()): boolean {
  const cur = currentAnalyticsPeriod(now);
  return period.year > cur.year || (period.year === cur.year && period.month > cur.month);
}

type ResourceOffice = "gso" | "it_infrastructure" | "sports_office";

function monthLabel(d: Date): string {
  return d.toLocaleString("en-US", { month: "short" });
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function isApprovedLike(status: RequestRow["status"]): boolean {
  return status === "approved" || status === "posted";
}

function actionFromStatus(status: RequestRow["status"]): ActivityItem["action"] {
  if (status === "declined") return "Rejected";
  if (status === "pending") return "Pending";
  return "Approved";
}

function iconForAction(action: ActivityItem["action"]): string {
  if (action === "Approved") return "✅";
  if (action === "Rejected") return "❌";
  return "⏳";
}

function relativeTime(iso: string): string {
  const now = Date.now();
  const t = new Date(iso).getTime();
  const deltaMs = Math.max(0, now - t);
  const mins = Math.floor(deltaMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min${mins > 1 ? "s" : ""} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr${hours > 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days > 1 ? "s" : ""} ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function organizationName(row: RequestRow): string {
  const raw = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
  const name = raw?.name?.trim();
  return name || "Organization";
}

function emptyOverview(): AnalyticsOverview {
  return {
    monthlyEvents: [],
    eventStatusData: [
      { name: "Approved", value: 0, color: "#4ADE80" },
      { name: "Pending", value: 0, color: "#D97706" },
      { name: "Rejected", value: 0, color: "#DC2626" },
    ],
    recentActivity: [],
    organizationData: [],
    collegeData: [],
    sdgUsage: [],
    records: [],
    totals: {
      totalThisYear: 0,
      approvedThisMonth: 0,
      approvedLastMonth: 0,
      pendingCount: 0,
      awaitingPublishCount: 0,
      allTimeCount: 0,
    },
    peakMonthLabel: "No data yet",
  };
}

function isResourceOfficeScope(scope: AnalyticsScope): scope is ResourceOffice {
  return scope === "gso" || scope === "it_infrastructure" || scope === "sports_office";
}

/**
 * Resolve request IDs that involve a resource office (assignment-based).
 * GSO also includes legacy current_step = gso requests.
 */
async function fetchResourceOfficeRequestIds(office: ResourceOffice): Promise<string[] | null> {
  const supabase = getSupabase();
  const pageSize = 500;
  const ids = new Set<string>();
  for (let from = 0; ; from += pageSize) {
    let assignmentQuery = supabase
      .from("event_request_resource_assignments")
      .select("request_id")
      .eq("assigned_office", office)
      .order("request_id", { ascending: true })
      .order("id", { ascending: true });

    if (office === "it_infrastructure") {
      assignmentQuery = assignmentQuery.eq("resource_kind", "equipment");
    } else if (office === "sports_office") {
      assignmentQuery = assignmentQuery.eq("resource_kind", "venue");
    }

    const { data, error } = await assignmentQuery.range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ request_id: string | null }>;
    rows.forEach((row) => {
      if (row.request_id) ids.add(row.request_id);
    });
    if (rows.length < pageSize) break;
  }

  if (office === "gso") {
    const since = new Date();
    since.setFullYear(since.getFullYear() - 1);
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from("event_requests")
        .select("id")
        .eq("current_step", "gso")
        .is("deleted_at", null)
        .gte("created_at", since.toISOString())
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      const rows = (data ?? []) as Array<{ id: string }>;
      rows.forEach((row) => ids.add(row.id));
      if (rows.length < pageSize) break;
    }
  }

  return [...ids];
}

function collegeNameForRow(row: RequestRow, collegeNameById: Map<string, string>): string {
  const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
  return org?.college_id
    ? (collegeNameById.get(org.college_id) ?? "Unassigned College")
    : "Unassigned College";
}

function toRecord(
  row: RequestRow,
  collegeNameById: Map<string, string>,
): AnalyticsEventRecord {
  return {
    id: row.id,
    activity: row.activity || "Untitled event",
    status: actionFromStatus(row.status),
    org: organizationName(row),
    college: collegeNameForRow(row, collegeNameById),
    createdAt: row.created_at,
    sdgIds: parseSdgsFromStorage(row.sdgs),
  };
}

function buildOverview(
  rows: RequestRow[],
  collegeNameById: Map<string, string>,
  anchor: Date,
): AnalyticsOverview {
  const thisMonthStart = startOfMonth(anchor);
  const lastMonthStart = new Date(thisMonthStart.getFullYear(), thisMonthStart.getMonth() - 1, 1);
  const nextMonthStart = new Date(thisMonthStart.getFullYear(), thisMonthStart.getMonth() + 1, 1);

  const months: Date[] = [];
  for (let i = 5; i >= 0; i--) {
    months.push(new Date(anchor.getFullYear(), anchor.getMonth() - i, 1));
  }
  const monthMap = new Map<string, MonthlyPoint>();
  months.forEach((m) => {
    const key = `${m.getFullYear()}-${m.getMonth()}`;
    monthMap.set(key, { id: key, month: monthLabel(m), events: 0, approved: 0, rejected: 0 });
  });

  rows.forEach((row) => {
    const d = new Date(row.created_at);
    const point = monthMap.get(`${d.getFullYear()}-${d.getMonth()}`);
    if (!point) return;
    point.events += 1;
    if (isApprovedLike(row.status)) point.approved += 1;
    if (row.status === "declined") point.rejected += 1;
  });

  const monthRows = rows.filter((row) => {
    const d = new Date(row.created_at);
    return d >= thisMonthStart && d < nextMonthStart;
  });

  if (!monthRows.length && !rows.length) return emptyOverview();

  const orgMap = new Map<string, number>();
  const collegeMap = new Map<string, number>();
  const sdgMap = new Map<number, number>();
  let approved = 0;
  let pending = 0;
  let rejected = 0;
  let approvedThisMonth = 0;
  let approvedLastMonth = 0;
  let awaitingPublish = 0;

  rows.forEach((row) => {
    const d = new Date(row.created_at);
    if (isApprovedLike(row.status) && d >= lastMonthStart && d < thisMonthStart) {
      approvedLastMonth += 1;
    }
  });

  monthRows.forEach((row) => {
    if (isApprovedLike(row.status)) {
      approved += 1;
      approvedThisMonth += 1;
    } else if (row.status === "declined") {
      rejected += 1;
    } else {
      pending += 1;
    }

    if (
      row.current_step === "eo_publish" &&
      (row.status === "pending" || row.status === "approved")
    ) {
      awaitingPublish += 1;
    }

    const orgName = organizationName(row);
    orgMap.set(orgName, (orgMap.get(orgName) ?? 0) + 1);
    const collegeName = collegeNameForRow(row, collegeNameById);
    collegeMap.set(collegeName, (collegeMap.get(collegeName) ?? 0) + 1);
    for (const sdgId of parseSdgsFromStorage(row.sdgs)) {
      sdgMap.set(sdgId, (sdgMap.get(sdgId) ?? 0) + 1);
    }
  });

  const monthlyEvents = Array.from(monthMap.values());
  const peak = monthlyEvents.reduce((a, b) => (a.events >= b.events ? a : b), monthlyEvents[0]!);
  const peakMonthLabel =
    peak && peak.events > 0 ? `${peak.month} ${anchor.getFullYear()}` : "No data yet";

  const recentActivity = monthRows.slice(0, 5).map((row, idx) => {
    const action = actionFromStatus(row.status);
    return {
      id: idx + 1,
      action,
      event: row.activity || "Untitled event",
      time: relativeTime(row.created_at),
      org: organizationName(row),
      icon: iconForAction(action),
    } satisfies ActivityItem;
  });

  const organizationData = Array.from(orgMap.entries())
    .map(([org, events]) => ({ org, events }))
    .sort((a, b) => b.events - a.events);
  const collegeData = Array.from(collegeMap.entries())
    .map(([college, events]) => ({ college, events }))
    .sort((a, b) => b.events - a.events);
  const sdgColors = ["#16A34A", "#0D9488", "#2563EB", "#D97706", "#7C3AED", "#DC2626"];
  const sdgUsage = Array.from(sdgMap.entries())
    .map(([id, value]) => ({ id, name: sdgLabel(id), value }))
    .sort((a, b) => b.value - a.value || a.id - b.id)
    .map((item, index) => ({ ...item, color: sdgColors[index % sdgColors.length]! }));

  return {
    monthlyEvents,
    eventStatusData: [
      { name: "Approved", value: approved, color: "#4ADE80" },
      { name: "Pending", value: pending, color: "#D97706" },
      { name: "Rejected", value: rejected, color: "#DC2626" },
    ],
    recentActivity,
    organizationData,
    collegeData,
    sdgUsage,
    records: monthRows.map((row) => toRecord(row, collegeNameById)),
    totals: {
      totalThisYear: monthRows.length,
      approvedThisMonth,
      approvedLastMonth,
      pendingCount: pending,
      awaitingPublishCount: awaitingPublish,
      allTimeCount: monthRows.length,
    },
    peakMonthLabel,
  };
}

/**
 * Role-scoped analytics. Filters are applied in the query (or request-id prefilter),
 * then all cards/charts/tables are computed only from that authorized set.
 */
export async function fetchAnalyticsOverview(
  scope: AnalyticsScope,
  options: AnalyticsScopeOptions = {},
): Promise<AnalyticsOverview> {
  if (!isSupabaseConfigured) return emptyOverview();

  const collegeId = options.collegeId?.trim() || null;
  const programId = options.programId?.trim() || null;
  const organizationId = options.organizationId?.trim() || null;
  const userId = options.userId?.trim() || null;
  const period = options.period ?? currentAnalyticsPeriod();
  const anchor = new Date(period.year, period.month - 1, 1);
  const since = new Date(anchor.getFullYear(), anchor.getMonth() - 5, 1);
  const until = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);

  // Missing required scope keys must not fall back to campus-wide data.
  if (scope === "dean" && !collegeId) {
    return emptyOverview();
  }
  if (scope === "adviser" && !programId && !organizationId) {
    return emptyOverview();
  }
  if (scope === "student_officer" && !organizationId && !userId) {
    return emptyOverview();
  }

  const supabase = getSupabase();
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();

  const useInnerOrg = scope === "dean" || (scope === "adviser" && !!programId);
  const orgSelect = useInnerOrg
    ? "organizations!inner(name, college_id, program_id)"
    : "organizations(name, college_id, program_id)";

  let resourceRequestIds: string[] | null = null;
  if (isResourceOfficeScope(scope)) {
    resourceRequestIds = await fetchResourceOfficeRequestIds(scope);
    if (!resourceRequestIds || !resourceRequestIds.length) {
      const overview = emptyOverview();
      const pendingCount = await countPendingForRole(scope as AppRole, userId ?? "", {
        collegeId,
        programId,
        organizationId,
      });
      overview.totals.pendingCount = pendingCount;
      const pendingSlice = overview.eventStatusData.find((slice) => slice.name === "Pending");
      if (pendingSlice) pendingSlice.value = pendingCount;
      return overview;
    }
  }
  // eo / osas: campus-wide (matches workflow visibility) — no college filter

  function buildQuery(idChunk?: string[]) {
    let query = supabase
      .from("event_requests")
      .select(
        `id, activity, status, current_step, created_at, sdgs, ${orgSelect}`,
      )
      .is("deleted_at", null)
      .gte("created_at", sinceIso)
      .lt("created_at", untilIso)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    if (scope === "ssc") {
      query = query.eq("request_type", "ssc");
    } else if (scope === "student_officer") {
      query = query.eq("request_type", "student_officer");
      if (organizationId) query = query.eq("organization_id", organizationId);
      else if (userId) query = query.eq("submitted_by", userId);
    } else if (scope === "dean") {
      query = query.eq("organizations.college_id", collegeId!);
    } else if (scope === "adviser") {
      if (programId) query = query.eq("organizations.program_id", programId);
      else if (organizationId) query = query.eq("organization_id", organizationId);
    }
    if (idChunk?.length) query = query.in("id", idChunk);
    return query;
  }

  const pageSize = 500;
  const idChunks = resourceRequestIds
    ? Array.from(
        { length: Math.ceil(resourceRequestIds.length / pageSize) },
        (_, index) => resourceRequestIds!.slice(index * pageSize, (index + 1) * pageSize),
      )
    : [undefined];
  const rowsById = new Map<string, RequestRow>();
  for (const idChunk of idChunks) {
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await buildQuery(idChunk).range(from, from + pageSize - 1);
      if (error) throw error;
      const pageRows = (data ?? []) as unknown as RequestRow[];
      pageRows.forEach((row) => rowsById.set(row.id, row));
      if (pageRows.length < pageSize) break;
    }
  }
  const rows = [...rowsById.values()].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const { data: collegeRows } = await supabase.from("colleges").select("id, name");
  const collegeNameById = new Map<string, string>(
    ((collegeRows ?? []) as Array<{ id: string; name: string | null }>).map((c) => [
      c.id,
      c.name?.trim() || "College",
    ]),
  );

  const overview = buildOverview(rows, collegeNameById, anchor);
  return overview;
}
