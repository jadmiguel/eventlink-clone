/** Postgres enums (public schema). */
export type DbRequestType = "student_officer" | "ssc" | "eo_direct";
export type DbRequestStatus =
  | "pending"
  | "declined"
  | "approved"
  | "posted"
  | "cancelled"
  | "revision_requested";
export type DbWorkflowStep =
  | "adviser"
  | "dean"
  | "osas"
  | "eo_schedule"
  | "gso"
  | "eo_publish"
  | "resource_offices";

export type EventRequestRow = {
  id: string;
  request_type: DbRequestType;
  status: DbRequestStatus;
  current_step: DbWorkflowStep | null;
  organization_id: string | null;
  submitted_by: string;
  activity: string;
  start_date: string;
  end_date: string;
  start_time: string;
  end_time: string;
  venue: string;
  venue_id?: string | null;
  number_of_participants: number;
  sdgs: string;
  purpose: string;
  needs_gso: boolean;
  letter_path: string | null;
  original_letter_path?: string | null;
  cancellation_reason?: string | null;
  cancelled_at?: string | null;
  cancelled_by?: string | null;
  deleted_at?: string | null;
  deleted_by?: string | null;
  deleted_reason?: string | null;
  decline_reason: string | null;
  declined_at_step: DbWorkflowStep | null;
  posted_at: string | null;
  calendar_posted_at: string | null;
  student_post_caption: string | null;
  student_post_image_path: string | null;
  created_at: string;
  updated_at: string;
  organizations?: { id?: string; name: string; college_id?: string; program_id?: string | null } | null;
  profiles?: { display_name: string } | null;
  event_request_equipment?: Array<{
    quantity_requested: number;
    equipment?: { id: string; name: string } | null;
  }> | null;
  event_request_resource_assignments?: Array<{
    id: string;
    resource_kind: "venue" | "equipment";
    venue_id: string | null;
    equipment_id: string | null;
    resource_name: string;
    quantity: number;
    assigned_office: string;
    status: "pending" | "approved" | "declined";
    decline_reason: string | null;
  }> | null;
  event_request_office_notes?: Array<{
    assigned_office: string;
    note: string;
  }> | null;
  event_request_letters?: Array<{
    id: string;
    letter_path: string;
    label: string;
    created_at: string;
  }> | null;
  event_request_compliance_comments?: Array<{
    id: string;
    comment: string;
    attachment_path: string | null;
    attachment_name: string | null;
    sender_id: string | null;
    sender_role: string;
    created_at: string;
    profiles?: { display_name: string } | null;
  }> | null;
};

export type EventRequestHistoryRow = {
  id: string;
  request_id: string;
  actor_id: string | null;
  action: string;
  step: DbWorkflowStep | null;
  comment: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
  profiles?: { display_name: string } | null;
};

export type CreateEventRequestInput = {
  requestType: DbRequestType;
  organizationId?: string | null;
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
  needsGso: boolean;
  letterFile?: File | null;
  letterFiles?: File[];
  equipment?: { equipmentId: string; quantity: number }[];
};
