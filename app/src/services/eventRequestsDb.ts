import { getSupabase } from "@/lib/supabase";
import { MAX_PROPOSAL_PDFS, uploadEventLetter } from "@/services/eventLetterStorage";
import { getEventPostImagePublicUrl, uploadEventPostImage } from "@/services/eventPostImageStorage";
import {
  enqueueNotification,
  type NotificationEventType,
} from "@/services/notificationsDb";
import { sendNotificationEmail } from "@/services/notificationEmail";
import type { PublishStudentPostInput } from "@/types/studentPost";
import type { AppRole } from "@/types/appRole";
import type {
  CreateEventRequestInput,
  EventRequestHistoryRow,
  EventRequestRow,
} from "@/types/eventRequest";
import type { PortalEvent } from "@/types/portalEvent";
import {
  appRoleToResourceOffice,
  buildWorkflowHistory,
  getInitialStep,
  getNextStep,
  roleMatchesStep,
  stepLabel,
  workflowStatusForResourceOffices,
  workflowStatusForStep,
} from "@/services/eventRequestWorkflow";
import type { DbWorkflowStep } from "@/types/eventRequest";
import type { ResourceAssignmentInput, ResourceOffice } from "@/types/resourceOffice";
import {
  EQUIPMENT_OFFICES,
  VENUE_OFFICES,
  isResourceOffice,
  resourceOfficeLabel,
} from "@/types/resourceOffice";

function formatTime(t: string): string {
  if (!t) return "";
  const parts = t.split(":");
  if (parts.length < 2) return t;
  let h = parseInt(parts[0] ?? "0", 10);
  const m = parts[1] ?? "00";
  const am = h < 12;
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${m} ${am ? "AM" : "PM"}`;
}

function formatShortDate(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDateRange(start: string, end: string): string {
  if (start === end) return formatShortDate(start);
  return `${formatShortDate(start)} – ${formatShortDate(end)}`;
}

function formatEventScheduleSnippet(row: {
  start_date: string;
  end_date: string;
  start_time: string;
  end_time: string;
  venue: string;
}): string {
  const when = formatDateRange(row.start_date, row.end_date);
  const time = [formatTime(row.start_time), formatTime(row.end_time)].filter(Boolean).join(" – ");
  const venue = row.venue?.trim() || "TBA";
  return `${when}${time ? ` · ${time}` : ""} · ${venue}`;
}

type NotificationPayload = {
  userId: string;
  eventType: NotificationEventType;
  requestId: string;
  dedupKey: string;
  detail?: string;
};

async function notifyCurrentStepReviewers(requestId: string): Promise<void> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc("enqueue_current_step_review_notifications", {
      p_request_id: requestId,
    });
    if (error || !data) return;
    const ids = (Array.isArray(data) ? data : [data]).map((id) => String(id ?? "")).filter(Boolean);
    await Promise.all(ids.map((notificationId) => sendNotificationEmail({ notificationId }).catch(() => undefined)));
  } catch {
    // Workflow already committed; reviewer email remains best effort.
  }
}

async function notifyUser(payload: NotificationPayload): Promise<void> {
  try {
    await enqueueNotification({
      userId: payload.userId,
      eventType: payload.eventType,
      requestId: payload.requestId,
      dedupKey: payload.dedupKey,
      context: payload.detail ? { detail: payload.detail } : {},
    });
  } catch {
    // Workflow already committed; notification delivery remains best effort.
  }
}

async function notifyUsersWithRole(
  role: ResourceOffice,
  payload: Omit<NotificationPayload, "userId">,
): Promise<void> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("event_resource_notification_recipients", {
    p_request_id: payload.requestId,
    p_office: role,
  });
  if (error || !data?.length) return;
  const uniqueIds = [
    ...new Set(
      (data as Array<{ user_id: string | null }>).map((r) => r.user_id).filter((id): id is string => !!id),
    ),
  ];
  await Promise.all(uniqueIds.map((userId) => notifyUser({ ...payload, userId })));
}

function roleLabel(role: string): string {
  const map: Record<string, string> = {
    eo: "Executive Officer",
    osas: "OSAS",
    adviser: "Adviser",
    dean: "Dean",
    admin: "Admin",
    gso: "GSO",
    it_infrastructure: "IT Infrastructure",
    sports_office: "Sports Office",
    ssc: "SSC",
    student_officer: "Student Officer",
  };
  return map[role] ?? role;
}

function mapStatus(row: EventRequestRow): PortalEvent["status"] {
  if (row.status === "cancelled") return "Cancelled";
  if (row.status === "declined" || row.status === "revision_requested") return "Pending";
  if (row.status === "posted") return "Approved";
  if (row.status === "approved" && row.current_step === "eo_publish") return "Pending";
  if (row.status === "approved") return "Approved";
  return "Pending";
}

function equipmentSummary(row: EventRequestRow): string {
  const lines = row.event_request_equipment ?? [];
  if (!lines.length) return "";
  return lines
    .map((line) => {
      const name = line.equipment?.name?.trim() || "Equipment";
      const qty = Number(line.quantity_requested ?? 0);
      return `${name} (x${qty > 0 ? qty : 1})`;
    })
    .join(", ");
}

function extractCollegeTag(purpose: string | null | undefined): { college: string | null; cleanPurpose: string } {
  const raw = (purpose ?? "").trim();
  const m = raw.match(/^\[COLLEGE:(.+?)\]\s*(.*)$/i);
  if (!m) return { college: null, cleanPurpose: raw };
  return {
    college: (m[1] ?? "").trim() || null,
    cleanPurpose: (m[2] ?? "").trim(),
  };
}

export function mapRowToPortalEvent(
  row: EventRequestRow,
  history: EventRequestHistoryRow[] = [],
): PortalEvent {
  const parsedPurpose = extractCollegeTag(row.purpose);
  const orgName = row.organizations?.name ?? parsedPurpose.college ?? "Organization";
  const submitter = row.profiles?.display_name ?? "Requester";
  const approvals = history
    .filter((h) => h.action === "approved" && h.step)
    .map((h) => ({
      step: h.step as DbWorkflowStep,
      approver: h.profiles?.display_name ?? "Staff",
      at: new Date(h.created_at).toLocaleString(),
    }));

  const pendingOffices = (row.event_request_resource_assignments ?? [])
    .filter((a) => a.status === "pending")
    .map((a) => a.assigned_office as ResourceOffice);

  const wfStatus =
    row.status === "cancelled"
      ? "Cancelled"
      : row.status === "revision_requested"
        ? "Revision Requested"
      : row.status === "declined"
      ? "Rejected"
      : row.status === "posted" || (row.status === "approved" && row.calendar_posted_at)
        ? "Approved"
        : row.current_step === "resource_offices"
          ? (workflowStatusForResourceOffices(pendingOffices) as PortalEvent["workflowStatus"])
          : row.current_step === "eo_publish"
            ? "Pending EO"
            : row.current_step === "eo_schedule"
              ? "Pending EO Review"
              : row.status === "approved"
                ? "Approved"
                : (workflowStatusForStep(row.current_step) as PortalEvent["workflowStatus"]);

  return {
    id: row.id,
    name: row.activity,
    activity: row.activity,
    date: formatDateRange(row.start_date, row.end_date),
    startDate: row.start_date,
    endDate: row.end_date,
    venue: row.venue,
    venueId: row.venue_id ?? null,
    status: mapStatus(row),
    workflowStatus: wfStatus,
    organization: orgName,
    eventType: row.request_type === "ssc" ? "SSC Event" : "Student Event",
    description: parsedPurpose.cleanPurpose,
    purpose: parsedPurpose.cleanPurpose,
    itemsEquipment: equipmentSummary(row),
    equipmentLines: (row.event_request_equipment ?? []).map((line) => ({
      equipmentId: line.equipment?.id ?? "",
      name: line.equipment?.name?.trim() || "Equipment",
      quantity: Math.max(1, Number(line.quantity_requested ?? 1)),
    })),
    startTime: formatTime(row.start_time),
    endTime: formatTime(row.end_time),
    participants: row.number_of_participants,
    sdgs: row.sdgs,
    requesterName: submitter,
    needsGSO: row.needs_gso,
    posted: row.status === "posted",
    calendarPosted: row.calendar_posted_at != null && row.status !== "cancelled",
    awaitingPublish: row.current_step === "eo_publish" && row.status !== "posted",
    awaitingCalendarPost: row.current_step === "eo_publish" && !row.calendar_posted_at,
    awaitingResourceAssignment: row.current_step === "eo_schedule" && row.status === "pending",
    resourceAssignments: (row.event_request_resource_assignments ?? []).map((a) => ({
      id: a.id,
      resourceKind: a.resource_kind,
      venueId: a.venue_id,
      equipmentId: a.equipment_id,
      resourceName: a.resource_name,
      quantity: a.quantity,
      assignedOffice: a.assigned_office as ResourceOffice,
      status: a.status,
      declineReason: a.decline_reason,
    })),
    officeNotes: Object.fromEntries(
      (row.event_request_office_notes ?? [])
        .filter((n) => isResourceOffice(n.assigned_office) && n.note.trim())
        .map((n) => [n.assigned_office, n.note]),
    ) as PortalEvent["officeNotes"],
    declineReason: row.decline_reason ?? undefined,
    cancellationReason: row.cancellation_reason ?? undefined,
    cancelledAt: row.cancelled_at ?? null,
    letterPath: row.letter_path,
    originalLetterPath: row.original_letter_path ?? row.letter_path ?? null,
    letterHistory: (row.event_request_letters ?? [])
      .slice()
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((l, idx, arr) => ({
        id: l.id,
        letterPath: l.letter_path,
        label: l.label || (idx === arr.length - 1 ? `Version ${arr.length - idx}` : `Version ${arr.length - idx}`),
        createdAt: l.created_at,
      })),
    complianceComments: (row.event_request_compliance_comments ?? [])
      .slice()
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((c) => ({
        id: c.id,
        comment: c.comment,
        attachmentPath: c.attachment_path,
        attachmentName: c.attachment_name,
        senderId: c.sender_id,
        senderRole: c.sender_role,
        senderName: c.profiles?.display_name ?? roleLabel(c.sender_role),
        createdAt: c.created_at,
      })),
    studentPostCaption: row.student_post_caption,
    updatedAt: row.updated_at ?? null,
    studentPostImagePath: row.student_post_image_path,
    studentPostImageUrl: row.student_post_image_path
      ? getEventPostImagePublicUrl(row.student_post_image_path)
      : null,
    postedAt: row.posted_at,
    workflowHistory: buildWorkflowHistory(
      row.request_type,
      row.current_step,
      row.needs_gso,
      approvals,
    ),
  };
}

/** Posted events only — for the public /student dashboard (works with anon + auth). */
export async function fetchPostedEventRequests(): Promise<EventRequestRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("public_event_requests");
  if (error) throw error;

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    status: "posted",
    current_step: null,
    submitted_by: null,
    needs_gso: false,
    letter_path: null,
    decline_reason: null,
    declined_at_step: null,
    organizations: row.organization_name
      ? {
          id: row.organization_id,
          name: row.organization_name,
          college_id: row.college_id,
        }
      : null,
    event_request_equipment: [],
  })) as unknown as EventRequestRow[];
}

const EVENT_REQUEST_LIST_SELECT = `
  id, request_type, status, current_step, organization_id, submitted_by,
  activity, start_date, end_date, start_time, end_time, venue, venue_id,
  number_of_participants, sdgs, purpose, needs_gso,
  letter_path, original_letter_path, decline_reason, declined_at_step,
  cancellation_reason, cancelled_at, cancelled_by,
  posted_at, calendar_posted_at, student_post_caption, student_post_image_path,
  created_at, updated_at,
  organizations ( id, name, college_id, program_id ),
  profiles!event_requests_submitted_by_fkey ( display_name ),
  event_request_equipment ( quantity_requested, equipment ( id, name ) ),
  event_request_resource_assignments (
    id, resource_kind, venue_id, equipment_id, resource_name, quantity,
    assigned_office, status, decline_reason
  ),
  event_request_office_notes ( assigned_office, note )
`;

const EVENT_REQUEST_LIST_SELECT_INNER_ORG = `
  id, request_type, status, current_step, organization_id, submitted_by,
  activity, start_date, end_date, start_time, end_time, venue, venue_id,
  number_of_participants, sdgs, purpose, needs_gso,
  letter_path, original_letter_path, decline_reason, declined_at_step,
  cancellation_reason, cancelled_at, cancelled_by,
  posted_at, calendar_posted_at, student_post_caption, student_post_image_path,
  created_at, updated_at,
  organizations!inner ( id, name, college_id, program_id ),
  profiles!event_requests_submitted_by_fkey ( display_name ),
  event_request_equipment ( quantity_requested, equipment ( id, name ) ),
  event_request_resource_assignments (
    id, resource_kind, venue_id, equipment_id, resource_name, quantity,
    assigned_office, status, decline_reason
  ),
  event_request_office_notes ( assigned_office, note )
`;

const EVENT_REQUEST_LIST_FALLBACK_SELECT = `
  id, request_type, status, current_step, organization_id, submitted_by,
  activity, start_date, end_date, start_time, end_time, venue, venue_id,
  number_of_participants, sdgs, purpose, needs_gso,
  letter_path, original_letter_path, decline_reason, declined_at_step,
  cancellation_reason, cancelled_at, cancelled_by,
  posted_at, calendar_posted_at, student_post_caption, student_post_image_path,
  created_at, updated_at,
  organizations ( id, name, college_id, program_id ),
  event_request_equipment ( quantity_requested, equipment ( id, name ) ),
  event_request_resource_assignments (
    id, resource_kind, venue_id, equipment_id, resource_name, quantity,
    assigned_office, status, decline_reason
  )
`;

const EVENT_REQUEST_LIST_BARE_SELECT = `
  id, request_type, status, current_step, organization_id, submitted_by,
  activity, start_date, end_date, start_time, end_time, venue, venue_id,
  number_of_participants, sdgs, purpose, needs_gso,
  letter_path, original_letter_path, decline_reason, declined_at_step,
  cancellation_reason, cancelled_at, cancelled_by,
  posted_at, calendar_posted_at, student_post_caption, student_post_image_path,
  created_at, updated_at,
  organizations ( id, name, college_id, program_id ),
  event_request_equipment ( quantity_requested, equipment ( id, name ) )
`;

const PORTAL_LIST_LIMIT = 100;

const ASSIGNMENT_LIST_SELECT =
  "id, request_id, resource_kind, venue_id, equipment_id, resource_name, quantity, assigned_office, status, decline_reason";

type AssignmentListRow = NonNullable<EventRequestRow["event_request_resource_assignments"]>[number] & {
  request_id: string;
};

/** Fill assignments only when the nested embed was missing (not when it is an empty array). */
async function attachResourceAssignments(rows: EventRequestRow[]): Promise<EventRequestRow[]> {
  if (!rows.length) return rows;
  const missing = rows.filter((r) => r.event_request_resource_assignments == null);
  const targetIds = [...new Set(missing.map((r) => r.id))];
  if (!targetIds.length) return rows;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("event_request_resource_assignments")
    .select(ASSIGNMENT_LIST_SELECT)
    .in("request_id", targetIds);
  if (error || !data) return rows;

  const byRequest = new Map<string, NonNullable<EventRequestRow["event_request_resource_assignments"]>>();
  for (const row of data as AssignmentListRow[]) {
    const list = byRequest.get(row.request_id) ?? [];
    list.push({
      id: row.id,
      resource_kind: row.resource_kind,
      venue_id: row.venue_id,
      equipment_id: row.equipment_id,
      resource_name: row.resource_name,
      quantity: row.quantity,
      assigned_office: row.assigned_office,
      status: row.status,
      decline_reason: row.decline_reason,
    });
    byRequest.set(row.request_id, list);
  }

  return rows.map((r) => {
    if (!targetIds.includes(r.id)) return r;
    return {
      ...r,
      event_request_resource_assignments: byRequest.get(r.id) ?? [],
    };
  });
}

export type PortalEventLoadScope = {
  role: AppRole;
  userId: string;
  collegeId?: string | null;
  programId?: string | null;
  organizationId?: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runEventRequestListQuery(select: string, apply: (q: any) => any): Promise<EventRequestRow[]> {
  const supabase = getSupabase();
  const base = supabase
    .from("event_requests")
    .select(select)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(PORTAL_LIST_LIMIT);
  const { data, error } = await apply(base);
  let rows: EventRequestRow[];
  if (error) {
    const fallbackBase = supabase
      .from("event_requests")
      .select(EVENT_REQUEST_LIST_FALLBACK_SELECT)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(PORTAL_LIST_LIMIT);
    const fallback = await apply(fallbackBase);
    if (fallback.error) {
      const bareBase = supabase
        .from("event_requests")
        .select(EVENT_REQUEST_LIST_BARE_SELECT)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(PORTAL_LIST_LIMIT);
      const bare = await apply(bareBase);
      if (bare.error) throw bare.error;
      rows = (bare.data ?? []) as EventRequestRow[];
    } else {
      rows = (fallback.data ?? []) as EventRequestRow[];
    }
  } else {
    rows = (data ?? []) as EventRequestRow[];
  }
  return attachResourceAssignments(rows);
}

/** Role-scoped fetch — avoids loading the full event_requests table on every portal view. */
export async function fetchPortalEventRequestsForRole(
  scope: PortalEventLoadScope,
): Promise<EventRequestRow[]> {
  const { role, userId, collegeId, programId, organizationId } = scope;

  switch (role) {
    case "student_officer": {
      if (organizationId) {
        return runEventRequestListQuery(EVENT_REQUEST_LIST_SELECT, (q) =>
          q.eq("request_type", "student_officer").eq("organization_id", organizationId),
        );
      }
      return runEventRequestListQuery(EVENT_REQUEST_LIST_SELECT, (q) =>
        q.eq("request_type", "student_officer").eq("submitted_by", userId),
      );
    }
    case "ssc":
      return runEventRequestListQuery(EVENT_REQUEST_LIST_SELECT, (q) =>
        q.or(
          "request_type.eq.ssc,and(status.eq.pending,current_step.eq.resource_offices),calendar_posted_at.not.is.null",
        ),
      );
    case "adviser": {
      if (programId) {
        return runEventRequestListQuery(EVENT_REQUEST_LIST_SELECT_INNER_ORG, (q) =>
          q.eq("organizations.program_id", programId),
        );
      }
      if (!organizationId) return [];
      return runEventRequestListQuery(EVENT_REQUEST_LIST_SELECT, (q) =>
        q.eq("organization_id", organizationId),
      );
    }
    case "dean": {
      if (!collegeId) return [];
      return runEventRequestListQuery(EVENT_REQUEST_LIST_SELECT_INNER_ORG, (q) =>
        q.eq("organizations.college_id", collegeId),
      );
    }
    case "gso":
    case "it_infrastructure":
    case "sports_office":
      return runEventRequestListQuery(EVENT_REQUEST_LIST_SELECT, (q) =>
        q.or(
          "and(status.eq.pending,current_step.in.(gso,resource_offices)),calendar_posted_at.not.is.null",
        ),
      );
    case "osas":
      return runEventRequestListQuery(EVENT_REQUEST_LIST_SELECT, (q) =>
        q.or(
          "and(status.eq.pending,current_step.in.(osas,eo_schedule,eo_publish,resource_offices)),status.in.(declined,cancelled,revision_requested),calendar_posted_at.not.is.null",
        ),
      );
    case "eo":
      return runEventRequestListQuery(EVENT_REQUEST_LIST_SELECT, (q) =>
        q.or(
          "and(status.eq.pending,current_step.in.(eo_schedule,eo_publish,resource_offices)),status.in.(cancelled,revision_requested),calendar_posted_at.not.is.null",
        ),
      );
    case "infirmary":
    case "nstp":
      return runEventRequestListQuery(EVENT_REQUEST_LIST_SELECT, (q) =>
        q.or(
          "status.in.(posted,cancelled),and(status.eq.approved,calendar_posted_at.not.is.null)",
        ),
      );
    default:
      return fetchAllEventRequests();
  }
}

/** Lazy-load document history + compliance comments for a single request (detail views). */
export async function fetchEventRequestDocuments(requestId: string): Promise<{
  letters: NonNullable<EventRequestRow["event_request_letters"]>;
  comments: NonNullable<EventRequestRow["event_request_compliance_comments"]>;
}> {
  const supabase = getSupabase();
  const [lettersRes, commentsRes] = await Promise.all([
    supabase
      .from("event_request_letters")
      .select("id, letter_path, label, created_at")
      .eq("request_id", requestId)
      .order("created_at", { ascending: false }),
    supabase
      .from("event_request_compliance_comments")
      .select("id, comment, attachment_path, attachment_name, sender_id, sender_role, created_at")
      .eq("request_id", requestId)
      .order("created_at", { ascending: false }),
  ]);
  return {
    letters: (lettersRes.data ?? []) as NonNullable<EventRequestRow["event_request_letters"]>,
    comments: (commentsRes.data ?? []) as NonNullable<EventRequestRow["event_request_compliance_comments"]>,
  };
}

export async function fetchAllEventRequests(): Promise<EventRequestRow[]> {
  return runEventRequestListQuery(EVENT_REQUEST_LIST_SELECT, (q) => q);
}

export async function fetchHistoryForRequest(requestId: string): Promise<EventRequestHistoryRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("event_request_history")
    .select("id, request_id, actor_id, action, step, comment, metadata, created_at, profiles ( display_name )")
    .eq("request_id", requestId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as EventRequestHistoryRow[];
}

export async function checkVenueAvailable(
  venue: string,
  startDate: string,
  endDate: string,
  excludeId?: string,
  startTime?: string,
  endTime?: string,
): Promise<boolean> {
  const supabase = getSupabase();
  const payload: Record<string, unknown> = {
    p_venue: venue,
    p_start: startDate,
    p_end: endDate,
    p_exclude_id: excludeId ?? null,
  };
  if (startTime && endTime) {
    payload.p_start_time = startTime.length === 5 ? `${startTime}:00` : startTime;
    payload.p_end_time = endTime.length === 5 ? `${endTime}:00` : endTime;
  }
  const { data, error } = await supabase.rpc("check_venue_availability", payload);
  if (error) throw error;
  return Boolean(data);
}

export async function createEventRequest(
  input: CreateEventRequestInput,
  submittedBy: string,
): Promise<string> {
  const { assertRateLimitAllowed } = await import("@/services/rateLimitDb");
  await assertRateLimitAllowed("event_submit");

  const letterFiles = (
    input.letterFiles?.length ? input.letterFiles : input.letterFile ? [input.letterFile] : []
  ).slice(0, MAX_PROPOSAL_PDFS);
  if (
    (input.requestType === "student_officer" || input.requestType === "ssc") &&
    letterFiles.length === 0
  ) {
    throw new Error("Please upload your PDF proposal (.pdf).");
  }

  const supabase = getSupabase();
  const requestId = crypto.randomUUID();
  const letterPaths: string[] = [];
  async function removeUploadedLetters() {
    if (!letterPaths.length) return;
    try {
      const { error: cleanupError } = await supabase.storage.from("event-letters").remove(letterPaths);
      if (cleanupError) {
        console.warn("Could not remove failed event proposal upload:", cleanupError.message);
      }
    } catch {
      // Best effort: storage cannot participate in the database transaction.
    }
  }
  if (letterFiles.length) {
    const { error: prepareError } = await supabase.rpc("prepare_event_request_upload", {
      p_request_id: requestId,
    });
    if (prepareError) throw prepareError;
    try {
      for (let index = 0; index < letterFiles.length; index += 1) {
        const file = letterFiles[index];
        if (!file) continue;
        letterPaths.push(await uploadEventLetter(file, submittedBy, requestId, index + 1));
      }
    } catch (uploadError) {
      await removeUploadedLetters();
      throw uploadError;
    }
  }

  const { error } = await supabase.rpc("create_event_request_transactional", {
    p_request_id: requestId,
    p_request: {
      request_type: input.requestType,
      organization_id: input.organizationId ?? null,
      activity: input.activity.trim(),
      start_date: input.startDate,
      end_date: input.endDate,
      start_time: input.startTime,
      end_time: input.endTime,
      venue: input.venue.trim(),
      venue_id: input.venueId ?? null,
      number_of_participants: input.numberOfParticipants,
      sdgs: input.sdgs?.trim() ?? "",
      purpose: input.purpose?.trim() ?? "",
      needs_gso: input.needsGso,
      letter_paths: letterPaths,
    },
    p_letter_path: letterPaths[0] ?? null,
    p_equipment: (input.equipment ?? []).map((line) => ({
      equipment_id: line.equipmentId,
      quantity: line.quantity,
    })),
  });

  if (error) {
    await removeUploadedLetters();
    throw error;
  }

  await notifyUser({
    userId: submittedBy,
    eventType: "request_submitted",
    requestId,
    dedupKey: `created:${requestId}`,
  });
  await notifyCurrentStepReviewers(requestId);

  return requestId;
}

async function getRow(id: string): Promise<EventRequestRow> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("event_requests")
    .select(
      `*, organizations ( id, name, college_id, program_id ), event_request_equipment ( quantity_requested, equipment ( id, name ) ), event_request_resource_assignments ( id, resource_kind, venue_id, equipment_id, resource_name, quantity, assigned_office, status, decline_reason )`,
    )
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as EventRequestRow;
}

async function assertActorCanHandleCurrentStep(
  row: EventRequestRow,
  actorId: string,
  actorRole: AppRole,
): Promise<void> {
  if (!row.current_step || !roleMatchesStep(actorRole, row.current_step)) {
    throw new Error(`This request is not awaiting ${stepLabel(row.current_step)}.`);
  }
  if (actorRole !== "adviser" && actorRole !== "dean") return;

  const supabase = getSupabase();
  const { data: actorProfile, error: actorErr } = await supabase
    .from("profiles")
    .select("college_id, organization_id")
    .eq("id", actorId)
    .maybeSingle();
  if (actorErr) throw actorErr;

  if (actorRole === "adviser") {
    if (!actorProfile?.organization_id || actorProfile.organization_id !== row.organization_id) {
      throw new Error("This request is assigned to a different organization adviser.");
    }
    return;
  }

  const requestCollegeId = row.organizations?.college_id ?? null;
  if (!actorProfile?.college_id || !requestCollegeId || actorProfile.college_id !== requestCollegeId) {
    throw new Error("This request is assigned to a different college dean.");
  }
}

export async function fetchDefaultOrganizationId(): Promise<string | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("organizations").select("id").limit(1).maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

export async function approveEventRequest(
  id: string,
  actorId: string,
  actorRole: AppRole,
): Promise<void> {
  const row = await getRow(id);
  if (row.current_step === "eo_publish") {
    throw new Error("Use Post to calendar (EO) or Post to students (organization) for this step.");
  }
  if (row.current_step === "eo_schedule" && actorRole === "eo") {
    throw new Error("Use Approve & Forward to assign resources to responsible offices.");
  }
  if (row.current_step === "resource_offices") {
    throw new Error("Use resource-office approval for assigned resources.");
  }
  if (row.status !== "pending") {
    throw new Error("Only pending requests can be approved.");
  }
  await assertActorCanHandleCurrentStep(row, actorId, actorRole);

  const supabase = getSupabase();
  const { error } = await supabase.rpc("event_workflow_decide", {
    p_request_id: id,
    p_decision: "approve",
    p_reason: null,
    p_attachment_path: null,
    p_attachment_name: null,
  });
  if (error) throw error;

  const next = getNextStep(row.request_type, row.current_step, row.needs_gso);
  const nextLabel = next ? stepLabel(next) : "final processing";
  await notifyUser({
    userId: row.submitted_by,
    eventType: "request_approved",
    requestId: id,
    dedupKey: `${id}:${row.current_step ?? "unknown"}:approved`,
    detail: `Approved at ${stepLabel(row.current_step)}. Next: ${nextLabel}.`,
  });
  await notifyCurrentStepReviewers(id);
}

/**
 * EO assigns each requested resource to one or more responsible offices and forwards.
 * Does not schedule — resource offices complete the workflow.
 */
export async function approveAndForwardEventRequest(
  id: string,
  actorId: string,
  assignments: ResourceAssignmentInput[],
): Promise<void> {
  void actorId; // Authentication identity is derived by the RPC from auth.uid().
  const { assertRateLimitAllowed } = await import("@/services/rateLimitDb");
  await assertRateLimitAllowed("event_mutate", id);
  const row = await getRow(id);
  if (row.status !== "pending" || row.current_step !== "eo_schedule") {
    throw new Error("Only requests pending EO review can be forwarded to resource offices.");
  }
  if (!assignments.length) {
    throw new Error("Assign a responsible office to every requested resource before forwarding.");
  }

  const venueAssignments = assignments.filter((a) => a.resourceKind === "venue");
  const equipmentAssignments = assignments.filter((a) => a.resourceKind === "equipment");
  const venueOffices = [...new Set(venueAssignments.map((a) => a.assignedOffice))];
  const equipmentOffices = [...new Set(equipmentAssignments.map((a) => a.assignedOffice))];

  if (!venueAssignments.length || !venueOffices.length) {
    throw new Error("Select at least one venue responsible office before forwarding.");
  }
  for (const office of venueOffices) {
    if (!VENUE_OFFICES.includes(office) || !isResourceOffice(office)) {
      throw new Error(`Invalid venue office: ${office}`);
    }
  }
  for (const office of equipmentOffices) {
    if (!EQUIPMENT_OFFICES.includes(office) || !isResourceOffice(office)) {
      throw new Error(`Invalid resource office: ${office}`);
    }
  }

  const hasRequestedEquipment =
    (row.event_request_equipment?.length ?? 0) > 0 || equipmentAssignments.length > 0;

  if (hasRequestedEquipment && !equipmentOffices.length) {
    throw new Error("Select at least one resource/equipment responsible office before forwarding.");
  }

  for (const a of assignments) {
    if (!a.assignedOffice) {
      throw new Error(`Missing responsible office for ${a.resourceName}.`);
    }
    if (!a.resourceName.trim()) {
      throw new Error("Each resource assignment needs a name.");
    }
  }

  // Deduplicate identical office+resource rows so EO cannot create duplicate work items.
  const seen = new Set<string>();
  const deduped = assignments.filter((a) => {
    const key = [
      a.resourceKind,
      a.assignedOffice,
      a.venueId ?? "",
      a.equipmentId ?? "",
      a.resourceName.trim().toLowerCase(),
      a.quantity,
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const rpcAssignments = deduped.map((a) => ({
    resource_kind: a.resourceKind,
    venue_id: a.venueId ?? null,
    equipment_id: a.equipmentId ?? null,
    resource_name: a.resourceName.trim(),
    quantity: Math.max(1, Math.floor(a.quantity || 1)),
    assigned_office: a.assignedOffice,
    office_note: a.officeNote?.trim() || null,
  }));
  const supabase = getSupabase();
  const { error } = await supabase.rpc("eo_forward_event_request", {
    p_request_id: id,
    p_assignments: rpcAssignments,
  });
  if (error) throw error;

  const officeList = [...new Set(deduped.map((a) => resourceOfficeLabel(a.assignedOffice)))].join(", ");

  await notifyUser({
    userId: row.submitted_by,
    eventType: "sent_to_resource_offices",
    requestId: id,
    dedupKey: `${id}:forwarded`,
    detail: `Assigned offices: ${officeList}.`,
  });

  const notifiedOffices = [...new Set(deduped.map((a) => a.assignedOffice))];
  await Promise.all(
    notifiedOffices.map((office) =>
      notifyUsersWithRole(office, {
        eventType: "resource_review_required",
        requestId: id,
        dedupKey: `${id}:${office}:review`,
        detail: `${resourceOfficeLabel(office)} review is required.`,
      }),
    ),
  );
}

export async function approveResourceAssignment(
  requestId: string,
  actorId: string,
  actorRole: AppRole,
): Promise<void> {
  void actorId;
  const office = appRoleToResourceOffice(actorRole);
  if (!office) throw new Error("This role cannot approve resource assignments.");

  const row = await getRow(requestId);
  if (row.status !== "pending" || row.current_step !== "resource_offices") {
    throw new Error("This request is not awaiting resource-office approval.");
  }

  const mine = (row.event_request_resource_assignments ?? []).filter(
    (a) => a.assigned_office === office && a.status === "pending",
  );
  if (!mine.length) {
    throw new Error("No pending resources are assigned to your office for this request.");
  }

  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("resource_office_decide_event_request", {
    p_request_id: requestId,
    p_decision: "approve",
    p_reason: null,
  });
  if (error) throw error;
  const result = data as EventRequestRow | null;
  if (result?.calendar_posted_at && !row.calendar_posted_at) {
    await notifyUser({
      userId: row.submitted_by,
      eventType: "event_scheduled",
      requestId,
      dedupKey: `${requestId}:scheduled`,
    });
  }
}

export async function declineResourceAssignment(
  requestId: string,
  actorId: string,
  actorRole: AppRole,
  reason: string,
): Promise<void> {
  void actorId;
  const office = appRoleToResourceOffice(actorRole);
  if (!office) throw new Error("This role cannot decline resource assignments.");

  const cleanReason = reason.trim();
  if (!cleanReason) throw new Error("A decline reason is required.");

  const row = await getRow(requestId);
  if (row.status !== "pending" || row.current_step !== "resource_offices") {
    throw new Error("This request is not awaiting resource-office approval.");
  }

  const mine = (row.event_request_resource_assignments ?? []).filter(
    (a) => a.assigned_office === office && a.status === "pending",
  );
  if (!mine.length) {
    throw new Error("No pending resources are assigned to your office for this request.");
  }

  const supabase = getSupabase();
  const { error } = await supabase.rpc("resource_office_decide_event_request", {
    p_request_id: requestId,
    p_decision: "decline",
    p_reason: cleanReason,
  });
  if (error) throw error;

  await notifyUser({
    userId: row.submitted_by,
    eventType: "resource_declined",
    requestId,
    dedupKey: `${requestId}:${office}:declined`,
    detail: `${resourceOfficeLabel(office)}: ${cleanReason}`,
  });
}

export async function declineEventRequest(
  id: string,
  actorId: string,
  actorRole: AppRole,
  reason: string,
): Promise<void> {
  const row = await getRow(id);
  if (row.status !== "pending") {
    throw new Error("Only pending requests can be declined.");
  }
  await assertActorCanHandleCurrentStep(row, actorId, actorRole);

  const cleanReason = reason.trim() || "Declined";
  const supabase = getSupabase();
  const { error } = await supabase.rpc("event_workflow_decide", {
    p_request_id: id,
    p_decision: "decline",
    p_reason: cleanReason,
    p_attachment_path: null,
    p_attachment_name: null,
  });
  if (error) throw error;

  await notifyUser({
    userId: row.submitted_by,
    eventType: "request_declined",
    requestId: id,
    dedupKey: `${id}:${row.current_step ?? "unknown"}:declined`,
    detail: `${stepLabel(row.current_step)}: ${cleanReason}`,
  });
}

function assertReadyForPublishStep(row: EventRequestRow): void {
  const ready =
    row.current_step === "eo_publish" &&
    (row.status === "approved" || row.status === "pending");
  if (!ready) {
    throw new Error("Event is not ready to publish. Complete prior approvals first.");
  }
}

/** SSC / student officer — visible on /student (caption + optional image). */
export async function postEventToStudents(
  id: string,
  actorId: string,
  actorRole: AppRole,
  input: PublishStudentPostInput,
): Promise<void> {
  if (actorRole !== "student_officer" && actorRole !== "ssc") {
    throw new Error("Only SSC or a student officer can post to the student dashboard.");
  }

  const caption = input.caption.trim();
  if (!caption) {
    throw new Error("Please write a caption for your post.");
  }

  const row = await getRow(id);
  if (row.status === "posted") {
    throw new Error("Event is already on the student dashboard.");
  }
  if (row.submitted_by !== actorId) {
    throw new Error("You can only publish your own event requests.");
  }
  assertReadyForPublishStep(row);

  let imagePath: string | null = null;
  if (input.imageFile) {
    imagePath = await uploadEventPostImage(input.imageFile, actorId, id);
  }

  const supabase = getSupabase();
  const { error } = await supabase.rpc("event_request_lifecycle", {
    p_request_id: id,
    p_action: "student_post",
    p_reason: null,
    p_caption: caption,
    p_image_path: imagePath,
  });
  if (error) throw error;

  await notifyUser({
    userId: row.submitted_by,
    eventType: "published_student_feed",
    requestId: id,
    dedupKey: `${id}:student-feed`,
  });
}

/** Executive Officer — staff schedule calendar only (not /student). */
export async function postEventToStaffCalendar(id: string, actorId: string): Promise<void> {
  void actorId;
  const row = await getRow(id);
  if (row.calendar_posted_at) {
    throw new Error("Event is already on the staff calendar.");
  }
  assertReadyForPublishStep(row);

  const supabase = getSupabase();
  const { error } = await supabase.rpc("event_request_lifecycle", {
    p_request_id: id,
    p_action: "calendar_post",
    p_reason: null,
    p_caption: null,
    p_image_path: null,
  });
  if (error) throw error;

  await notifyUser({
    userId: row.submitted_by,
    eventType: "published_staff_calendar",
    requestId: id,
    dedupKey: `${id}:staff-calendar`,
  });
}

export function isPendingForRole(
  r: EventRequestRow,
  role: AppRole,
  userId: string,
  scope?: { collegeId?: string | null; programId?: string | null; organizationId?: string | null },
): boolean {
  if (r.deleted_at) return false;
  const office = appRoleToResourceOffice(role);

  if (role === "student_officer") {
    if (scope?.organizationId) {
      return (
        r.request_type === "student_officer" &&
        r.organization_id === scope.organizationId &&
        r.status === "pending" &&
        r.current_step !== "eo_publish"
      );
    }
    return (
      r.request_type === "student_officer" &&
      r.submitted_by === userId &&
      r.status === "pending" &&
      r.current_step !== "eo_publish"
    );
  }
  if (role === "ssc") {
    // Keep SSC-submitted requests visible through resource-office approval.
    // Venue-assignment inbox stays separate via filterResourceOfficePending.
    return (
      r.request_type === "ssc" &&
      r.status === "pending" &&
      r.current_step !== "eo_publish"
    );
  }
  if (r.status !== "pending" && r.status !== "approved") return false;
  if (role === "eo") {
    if (r.current_step === "eo_schedule") return true;
    if (r.current_step === "eo_publish") {
      return !r.calendar_posted_at && (r.status === "pending" || r.status === "approved");
    }
    return false;
  }
  if (office && (role === "gso" || role === "it_infrastructure" || role === "sports_office")) {
    return hasPendingAssignmentForOffice(r, office);
  }
  if (role === "adviser") {
    const inScope = scope?.programId
      ? (r.organizations?.program_id ?? null) === scope.programId
      : !!scope?.organizationId && r.organization_id === scope.organizationId;
    if (!inScope) return false;
    return r.status === "pending" && r.current_step === "adviser";
  }
  if (role === "dean") {
    if (!scope?.collegeId) return false;
    return (
      r.status === "pending" &&
      r.current_step === "dean" &&
      (r.organizations?.college_id ?? null) === scope.collegeId
    );
  }
  if (role === "infirmary" || role === "nstp") return false;
  if (role === "admin") return r.status === "pending";
  return r.status === "pending" && roleMatchesStep(role, r.current_step);
}

export function filterPendingForRole(
  rows: EventRequestRow[],
  role: AppRole,
  userId: string,
  scope?: { collegeId?: string | null; programId?: string | null; organizationId?: string | null },
): EventRequestRow[] {
  return rows.filter((r) => isPendingForRole(r, role, userId, scope));
}

/** Same pending definition used by Event Management tables, badges, and dashboard counts. */
export function getPendingEventsForCurrentUser(
  rows: EventRequestRow[],
  role: AppRole,
  userId: string,
  scope?: { collegeId?: string | null; programId?: string | null; organizationId?: string | null },
): EventRequestRow[] {
  return filterPendingForRole(rows, role, userId, scope);
}

async function countExact(apply: (query: any) => any): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await apply(
    supabase.from("event_requests").select("id", { count: "exact", head: true }).is("deleted_at", null),
  );
  if (error) throw error;
  return count ?? 0;
}

async function countPendingResourceOffice(office: ResourceOffice): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("event_request_resource_assignments")
    .select("request_id")
    .eq("assigned_office", office)
    .eq("status", "pending")
    .limit(500);
  if (error) throw error;

  const assignmentIds = [
    ...new Set(
      ((data ?? []) as Array<{ request_id: string | null }>)
        .map((r) => r.request_id)
        .filter((id): id is string => !!id),
    ),
  ];

  let assignmentCount = 0;
  if (assignmentIds.length) {
    assignmentCount = await countExact((q) =>
      q.in("id", assignmentIds).eq("status", "pending").eq("current_step", "resource_offices"),
    );
  }

  if (office !== "gso") return assignmentCount;

  const legacyCount = await countExact((q) => q.eq("status", "pending").eq("current_step", "gso"));
  return assignmentCount + legacyCount;
}

/**
 * Head-count of requests currently awaiting action from this role.
 * Uses the same rules as `isPendingForRole` / Event Management pending tables.
 */
export async function countPendingForRole(
  role: AppRole,
  userId: string,
  scope?: { collegeId?: string | null; programId?: string | null; organizationId?: string | null },
): Promise<number> {
  if (role === "infirmary" || role === "nstp") return 0;

  if (role === "student_officer") {
    return countExact((q) => {
      let next = q
        .eq("request_type", "student_officer")
        .eq("status", "pending")
        .neq("current_step", "eo_publish");
      if (scope?.organizationId) next = next.eq("organization_id", scope.organizationId);
      else next = next.eq("submitted_by", userId);
      return next;
    });
  }

  if (role === "ssc") {
    return countExact((q) =>
      q.eq("request_type", "ssc").eq("status", "pending").neq("current_step", "eo_publish"),
    );
  }

  if (role === "eo") {
    return countExact((q) =>
      q
        .in("status", ["pending", "approved"])
        .or(
          "current_step.eq.eo_schedule,and(current_step.eq.eo_publish,calendar_posted_at.is.null)",
        ),
    );
  }

  const office = appRoleToResourceOffice(role);
  if (office && (role === "gso" || role === "it_infrastructure" || role === "sports_office")) {
    return countPendingResourceOffice(office);
  }

  if (role === "adviser") {
    if (scope?.programId) {
      const supabase = getSupabase();
      const { count, error } = await supabase
        .from("event_requests")
        .select("id, organizations!inner(program_id)", { count: "exact", head: true })
        .is("deleted_at", null)
        .eq("status", "pending")
        .eq("current_step", "adviser")
        .eq("organizations.program_id", scope.programId);
      if (error) throw error;
      return count ?? 0;
    }
    if (!scope?.organizationId) return 0;
    return countExact((q) =>
      q.eq("status", "pending").eq("current_step", "adviser").eq("organization_id", scope.organizationId!),
    );
  }

  if (role === "dean") {
    if (!scope?.collegeId) return 0;
    const supabase = getSupabase();
    const { count, error } = await supabase
      .from("event_requests")
      .select("id, organizations!inner(college_id)", { count: "exact", head: true })
      .is("deleted_at", null)
      .eq("status", "pending")
      .eq("current_step", "dean")
      .eq("organizations.college_id", scope.collegeId);
    if (error) throw error;
    return count ?? 0;
  }

  if (role === "osas") {
    return countExact((q) => q.eq("status", "pending").eq("current_step", "osas"));
  }

  if (role === "admin") {
    return countExact((q) => q.eq("status", "pending"));
  }

  return 0;
}

function hasPendingAssignmentForOffice(row: EventRequestRow, office: ResourceOffice): boolean {
  if (row.status !== "pending") return false;
  // Legacy GSO step without assignments
  if (office === "gso" && row.current_step === "gso") return true;
  if (row.current_step !== "resource_offices") return false;
  return (row.event_request_resource_assignments ?? []).some(
    (a) => a.assigned_office === office && a.status === "pending",
  );
}

/** Pending resource requests assigned by EO to a specific office (incl. SSC venue manager). */
export function filterResourceOfficePending(
  rows: EventRequestRow[],
  office: ResourceOffice,
): EventRequestRow[] {
  return rows.filter((r) => hasPendingAssignmentForOffice(r, office));
}

export function filterApprovedForRole(
  rows: EventRequestRow[],
  role: AppRole,
  userId: string,
  scope?: { organizationId?: string | null },
): EventRequestRow[] {
  return rows.filter((r) => {
    if (role === "student_officer") {
      const isApprovedLike =
        r.status === "approved" || r.status === "posted" || (r.status === "pending" && r.current_step === "eo_publish");
      if (!isApprovedLike || r.request_type !== "student_officer") return false;
      if (scope?.organizationId) return r.organization_id === scope.organizationId;
      return r.submitted_by === userId;
    }
    if (role === "ssc") {
      return (
        r.request_type === "ssc" &&
        (r.status === "approved" || r.status === "posted" || (r.status === "pending" && r.current_step === "eo_publish"))
      );
    }
    if (r.status !== "approved" && r.status !== "posted") return false;
    return true;
  });
}

export function filterDeclinedForRole(
  rows: EventRequestRow[],
  role: AppRole,
  userId: string,
  scope?: { organizationId?: string | null },
): EventRequestRow[] {
  if (role === "student_officer") {
    return rows.filter((r) => {
      if (r.request_type !== "student_officer") return false;
      if (r.status !== "declined" && r.status !== "revision_requested") return false;
      if (scope?.organizationId) return r.organization_id === scope.organizationId;
      return r.submitted_by === userId;
    });
  }
  if (role === "ssc") {
    return rows.filter(
      (r) =>
        r.request_type === "ssc" && (r.status === "declined" || r.status === "revision_requested"),
    );
  }
  return [];
}

export function filterPostedEvents(rows: EventRequestRow[]): EventRequestRow[] {
  return rows.filter((r) => r.status === "posted");
}

/** Staff schedule calendar (EO publishes here). Cancelled events stay in history but leave the calendar. */
export function filterCalendarEvents(rows: EventRequestRow[]): EventRequestRow[] {
  return rows.filter((r) => r.calendar_posted_at != null && r.status !== "cancelled" && !r.deleted_at);
}

const CALENDAR_LIST_SELECT = `
  id, request_type, status, current_step, organization_id, submitted_by,
  activity, start_date, end_date, start_time, end_time, venue, venue_id,
  number_of_participants, sdgs, purpose, needs_gso,
  letter_path, original_letter_path, decline_reason, declined_at_step,
  posted_at, calendar_posted_at, created_at, updated_at,
  organizations ( id, name, college_id, program_id )
`;

/**
 * Load only scheduled events overlapping a date window (month/week/day views).
 * Does not pull the full event_requests table.
 */
export async function fetchCalendarEventsInRange(params: {
  startDate: string;
  endDate: string;
}): Promise<EventRequestRow[]> {
  const start = params.startDate.trim();
  const end = params.endDate.trim();
  if (!start || !end) return [];
  const supabase = getSupabase();
  const pageSize = 500;
  const hardSafetyLimit = 5_000;
  const rows: EventRequestRow[] = [];

  for (let from = 0; from < hardSafetyLimit; from += pageSize) {
    const { data, error } = await supabase
      .from("event_requests")
      .select(CALENDAR_LIST_SELECT)
      .is("deleted_at", null)
      .not("calendar_posted_at", "is", null)
      .neq("status", "cancelled")
      .lte("start_date", end)
      .gte("end_date", start)
      .order("start_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    const pageRows = (data ?? []) as unknown as EventRequestRow[];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) return rows;
  }

  throw new Error(
    `Calendar range exceeds the ${hardSafetyLimit.toLocaleString()} event safety limit.`,
  );
}

/** Compact upcoming list for calendar side panels. */
export async function fetchUpcomingCalendarEvents(limit = 10): Promise<EventRequestRow[]> {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const start = `${yyyy}-${mm}-${dd}`;
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + 60);
  const end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, "0")}-${String(endDate.getDate()).padStart(2, "0")}`;

  const rows = await fetchCalendarEventsInRange({
    startDate: start,
    endDate: end,
  });
  return rows.slice(0, Math.min(50, Math.max(1, limit)));
}

/**
 * Cancel a scheduled event (EO). Does not delete the row — status becomes cancelled.
 */
export async function cancelScheduledEventRequest(
  id: string,
  actorId: string,
  reason: string,
): Promise<void> {
  void actorId;
  const cleanReason = reason.trim();
  if (!cleanReason) throw new Error("A cancellation note is required.");

  const row = await getRow(id);
  if (row.status === "cancelled") {
    throw new Error("This event is already cancelled.");
  }
  if (!row.calendar_posted_at || (row.status !== "approved" && row.status !== "posted")) {
    throw new Error("Only scheduled events can be cancelled from the calendar.");
  }

  const supabase = getSupabase();
  const { error } = await supabase.rpc("event_request_lifecycle", {
    p_request_id: id,
    p_action: "cancel",
    p_reason: cleanReason,
    p_caption: null,
    p_image_path: null,
  });
  if (error) throw error;

  await notifyUser({
    userId: row.submitted_by,
    eventType: "event_cancelled",
    requestId: id,
    dedupKey: `${id}:cancelled`,
    detail: `Reason: ${cleanReason}`,
  });
}

export async function unpostEventFromStaffCalendar(
  id: string,
  actorId: string,
): Promise<void> {
  void actorId;
  const row = await getRow(id);
  if (!row.calendar_posted_at) {
    throw new Error("This event is not posted to the staff calendar.");
  }
  const supabase = getSupabase();
  const { error } = await supabase.rpc("event_request_lifecycle", {
    p_request_id: id,
    p_action: "unpost",
    p_reason: null,
    p_caption: null,
    p_image_path: null,
  });
  if (error) throw error;
}

/**
 * Soft-delete an event so Event Trail history is retained.
 * Calendar, pending queues, and event lists hide the row.
 */
export async function softDeleteEventRequest(
  id: string,
  actorId: string,
  reason: string,
): Promise<void> {
  void actorId;
  const cleanReason = reason.trim();
  if (!cleanReason) throw new Error("A deletion reason is required.");
  const row = await getRow(id);
  if (row.deleted_at) throw new Error("This event is already deleted.");

  const supabase = getSupabase();
  const { error } = await supabase.rpc("event_request_lifecycle", {
    p_request_id: id,
    p_action: "delete",
    p_reason: cleanReason,
    p_caption: null,
    p_image_path: null,
  });
  if (error) throw error;
}

/** Events visible in Event Monitoring for eligible roles. */
export function filterMonitoringForRole(
  rows: EventRequestRow[],
  role: AppRole,
  userId: string,
  scope?: { collegeId?: string | null; programId?: string | null; organizationId?: string | null },
): EventRequestRow[] {
  return rows.filter((r) => {
    if (role === "admin" || role === "osas") return true;
    if (role === "adviser") {
      if (scope?.programId) return (r.organizations?.program_id ?? null) === scope.programId;
      if (!scope?.organizationId) return false;
      return r.organization_id === scope.organizationId;
    }
    if (role === "dean") {
      if (!scope?.collegeId) return false;
      return (r.organizations?.college_id ?? null) === scope.collegeId;
    }
    if (role === "student_officer") {
      if (scope?.organizationId) {
        return r.request_type === "student_officer" && r.organization_id === scope.organizationId;
      }
      return r.request_type === "student_officer" && r.submitted_by === userId;
    }
    if (role === "ssc") {
      return r.request_type === "ssc" || r.submitted_by === userId;
    }
    if (role === "eo") {
      return true;
    }
    return false;
  });
}

export type UpdateEventRequestInput = {
  activity: string;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  venue: string;
  venueId?: string | null;
  numberOfParticipants: number;
  sdgs?: string;
  purpose?: string;
  letterFile?: File | null;
};

async function resolveUpdatedVenueId(
  input: UpdateEventRequestInput,
  current: EventRequestRow,
): Promise<string | null> {
  if (input.venueId !== undefined) return input.venueId;
  const venue = input.venue.trim();
  if (venue.toLowerCase() === current.venue.trim().toLowerCase()) {
    return current.venue_id ?? null;
  }
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("venues")
    .select("id")
    .eq("name", venue)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

export async function requestRevision(
  id: string,
  actorId: string,
  actorRole: AppRole,
  comment: string,
  attachmentFile?: File | null,
): Promise<void> {
  const cleanComment = comment.trim();
  if (!cleanComment) {
    throw new Error("Compliance comment is required.");
  }

  const allowed: AppRole[] = ["eo", "osas", "adviser", "dean", "admin"];
  if (!allowed.includes(actorRole)) {
    throw new Error("You cannot request a revision for this request.");
  }

  const row = await getRow(id);
  if (row.status !== "pending") {
    throw new Error("Only pending requests can be sent for revision.");
  }
  if (actorRole !== "admin") {
    await assertActorCanHandleCurrentStep(row, actorId, actorRole);
  }

  let attachmentPath: string | null = null;
  let attachmentName: string | null = null;
  if (attachmentFile) {
    const { uploadComplianceAttachment } = await import("@/services/complianceAttachmentStorage");
    const uploaded = await uploadComplianceAttachment(attachmentFile, actorId, id);
    attachmentPath = uploaded.path;
    attachmentName = uploaded.name;
  }

  const supabase = getSupabase();
  const { error } = await supabase.rpc("event_workflow_decide", {
    p_request_id: id,
    p_decision: "revision",
    p_reason: cleanComment,
    p_attachment_path: attachmentPath,
    p_attachment_name: attachmentName,
  });
  if (error) throw error;

  await notifyUser({
    userId: row.submitted_by,
    eventType: "revision_requested",
    requestId: id,
    dedupKey: `${id}:${row.current_step ?? "unknown"}:${row.updated_at ?? "current"}:revision`,
    detail: cleanComment,
  });
}

export async function updateEventRequest(
  id: string,
  input: UpdateEventRequestInput,
  actorId: string,
): Promise<void> {
  void actorId;
  const row = await getRow(id);

  const available = await checkVenueAvailable(
    input.venue,
    input.startDate,
    input.endDate,
    id,
    input.startTime,
    input.endTime,
  );
  if (!available) {
    throw new Error(
      "This venue is already booked for an overlapping date and time. Choose a different time or venue.",
    );
  }

  const venueId = await resolveUpdatedVenueId(input, row);
  const supabase = getSupabase();
  const { error } = await supabase.rpc("update_event_request_transactional", {
    p_request_id: id,
    p_resubmit: false,
    p_letter_path: null,
    p_patch: {
      activity: input.activity.trim(),
      start_date: input.startDate,
      end_date: input.endDate,
      start_time: input.startTime,
      end_time: input.endTime,
      venue: input.venue.trim(),
      venue_id: venueId,
      number_of_participants: input.numberOfParticipants,
      sdgs: input.sdgs?.trim() ?? "",
      purpose: input.purpose?.trim() ?? "",
    },
  });

  if (error) throw error;
  const venue = input.venue.trim();

  const newSchedule = formatEventScheduleSnippet({
    start_date: input.startDate,
    end_date: input.endDate,
    start_time: input.startTime,
    end_time: input.endTime,
    venue: venue,
  });

  await notifyUser({
    userId: row.submitted_by,
    eventType: "schedule_updated",
    requestId: id,
    dedupKey: `${id}:${row.updated_at ?? "current"}:schedule`,
    detail: `New schedule: ${newSchedule}.`,
  });
}

export async function resubmitDeclinedEventRequest(
  id: string,
  input: UpdateEventRequestInput,
  actorId: string,
  actorRole: AppRole,
): Promise<void> {
  const row = await getRow(id);
  if (row.status !== "declined" && row.status !== "revision_requested") {
    throw new Error("Only declined or revision-requested requests can be edited and resubmitted.");
  }
  if (row.submitted_by !== actorId) {
    throw new Error("You can only resubmit your own requests.");
  }
  if (actorRole === "student_officer" && row.request_type !== "student_officer") {
    throw new Error("This request is not a Student Officer request.");
  }
  if (actorRole === "ssc" && row.request_type !== "ssc") {
    throw new Error("This request is not an SSC request.");
  }

  const available = await checkVenueAvailable(
    input.venue,
    input.startDate,
    input.endDate,
    id,
    input.startTime,
    input.endTime,
  );
  if (!available) {
    throw new Error(
      "This venue is already booked for an overlapping date and time. Choose a different time or venue.",
    );
  }

  const wasRevision = row.status === "revision_requested";
  const resumeStep =
    wasRevision && row.declined_at_step
      ? row.declined_at_step
      : getInitialStep(row.request_type);

  const supabase = getSupabase();
  const venueId = await resolveUpdatedVenueId(input, row);
  let revisedLetterPath: string | null = null;
  if (input.letterFile) {
    const { error: prepareError } = await supabase.rpc("prepare_event_request_upload", {
      p_request_id: id,
    });
    if (prepareError) throw prepareError;
    revisedLetterPath = await uploadEventLetter(input.letterFile, actorId, id);
  }

  const { error } = await supabase.rpc("update_event_request_transactional", {
    p_request_id: id,
    p_resubmit: true,
    p_letter_path: revisedLetterPath,
    p_patch: {
      activity: input.activity.trim(),
      start_date: input.startDate,
      end_date: input.endDate,
      start_time: input.startTime,
      end_time: input.endTime,
      venue: input.venue.trim(),
      venue_id: venueId,
      number_of_participants: input.numberOfParticipants,
      sdgs: input.sdgs?.trim() ?? "",
      purpose: input.purpose?.trim() ?? "",
    },
  });
  if (error) {
    if (revisedLetterPath) {
      try {
        const { error: cleanupError } = await supabase.storage
          .from("event-letters")
          .remove([revisedLetterPath]);
        if (cleanupError) {
          console.warn("Could not remove failed revised proposal upload:", cleanupError.message);
        }
      } catch {
        // Best effort: storage cannot participate in the database transaction.
      }
    }
    throw error;
  }

  await notifyUser({
    userId: row.submitted_by,
    eventType: "request_resubmitted",
    requestId: id,
    dedupKey: `${id}:${row.updated_at ?? "current"}:resubmitted`,
    detail: `Next: ${stepLabel(resumeStep)}.`,
  });
  await notifyCurrentStepReviewers(id);
}
