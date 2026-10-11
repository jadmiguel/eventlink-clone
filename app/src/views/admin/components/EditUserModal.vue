<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { X } from "lucide-vue-next";
import { useUiStore } from "@/stores/ui";
import { updatePortalUser } from "@/services/adminCreateUser";
import { fetchCollegesWithOrganizations, type CollegeWithOrgs } from "@/services/collegesDb";
import { fetchRequireIsuEmail } from "@/services/appSettingsDb";
import { EMAIL_FORMAT_ERROR, ISU_EMAIL_ERROR, emailMeetsAdminPolicy } from "@/utils/isuEmail";
import { LEGACY_STUDENT_ROLE, type AppRole } from "@/types/appRole";
import {
  adminRoleLabel,
  fetchAdminOrgAssignments,
  officerNamesByOrganizationId,
  type AdminOrgAssignmentRow,
} from "@/services/adminUsersDb";

type EditableRole =
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

type EditableUser = {
  userId: string;
  appRole: AppRole | typeof LEGACY_STUDENT_ROLE;
  name: string;
  email: string;
  college: string;
  program: string;
};

const props = defineProps<{
  open: boolean;
  user: EditableUser | null;
}>();
const emit = defineEmits<{ close: []; updated: [] }>();

const ui = useUiStore();
const saving = ref(false);
const loadingOptions = ref(false);
const colleges = ref<CollegeWithOrgs[]>([]);
const orgAssignments = ref<AdminOrgAssignmentRow[]>([]);
const requireIsuEmail = ref(true);

const role = ref<EditableRole>("adviser");
const name = ref("");
const email = ref("");
const collegeId = ref("");
const programId = ref("");
const organizationId = ref("");

const roleOptions: Array<{ label: string; value: EditableRole }> = [
  { label: "Student Officer", value: "student_officer" },
  { label: "SSC", value: "ssc" },
  { label: "Adviser", value: "adviser" },
  { label: "Dean", value: "dean" },
  { label: "OSAS", value: "osas" },
  { label: "EO", value: "eo" },
  { label: "GSO", value: "gso" },
  { label: "IT Infrastructure", value: "it_infrastructure" },
  { label: "Sports Office", value: "sports_office" },
  { label: "Infirmary", value: "infirmary" },
  { label: "NSTP", value: "nstp" },
  { label: "Admin", value: "admin" },
];

const requiresCollege = computed(
  () => role.value === "student_officer" || role.value === "adviser" || role.value === "dean",
);
const requiresProgram = computed(
  () => role.value === "student_officer" || role.value === "adviser",
);
const requiresOrganization = computed(() => role.value === "student_officer");
const selectedCollegeRow = computed(() => colleges.value.find((c) => c.id === collegeId.value) ?? null);
const programOptions = computed(() => selectedCollegeRow.value?.programs ?? []);
const organizationOptions = computed(() => {
  const selected = programOptions.value.find((program) => program.id === programId.value);
  return selected?.organizations ?? [];
});
const officerByOrgId = computed(() => officerNamesByOrganizationId(orgAssignments.value));
const selectedOrgOfficer = computed(() => {
  if (!organizationId.value) return "";
  const assigned = officerByOrgId.value.get(organizationId.value) ?? "";
  if (!assigned) return "";
  const currentName = props.user?.name.trim();
  const others = assigned
    .split(", ")
    .map((n) => n.trim())
    .filter((n) => n && n !== currentName);
  return others.join(", ");
});

function organizationOptionLabel(orgId: string, orgName: string): string {
  const officer = officerByOrgId.value.get(orgId);
  return officer ? `${orgName} — Officer: ${officer}` : orgName;
}

function coerceEditableRole(value: AppRole | typeof LEGACY_STUDENT_ROLE): EditableRole {
  if (value === LEGACY_STUDENT_ROLE) return "student_officer";
  return value;
}

function resetForm() {
  if (!props.user) return;
  role.value = coerceEditableRole(props.user.appRole);
  name.value = props.user.name;
  email.value = props.user.email.trim() === "—" ? "" : props.user.email;
  collegeId.value = "";
  programId.value = "";
  organizationId.value = "";
}

function prefillCollegeAndOrganizationByName() {
  if (!props.user) return;
  if (!requiresCollege.value) return;

  const targetCollege = props.user.college.trim().toLowerCase();
  const selectedCollege = colleges.value.find((c) => c.name.trim().toLowerCase() === targetCollege);
  if (!selectedCollege) return;
  collegeId.value = selectedCollege.id;

  const target = props.user.program.trim().toLowerCase();
  const matchedProgram = selectedCollege.programs.find((program) => program.name.trim().toLowerCase() === target);
  if (role.value === "adviser") {
    if (matchedProgram) programId.value = matchedProgram.id;
    return;
  }
  if (!requiresOrganization.value) return;

  if (matchedProgram) programId.value = matchedProgram.id;
  const selectedOrg =
    selectedCollege.organizations.find((org) => org.name.trim().toLowerCase() === target) ??
    (matchedProgram
      ? matchedProgram.organizations.find((org) => org.name.trim().toLowerCase() === target)
      : undefined);
  if (!selectedOrg) return;
  organizationId.value = selectedOrg.id;
  if (selectedOrg.program_id) programId.value = selectedOrg.program_id;
}

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return;
    resetForm();
    loadingOptions.value = true;
    try {
      const [collegeRows, assignments, isuRequired] = await Promise.all([
        fetchCollegesWithOrganizations(),
        fetchAdminOrgAssignments().catch(() => [] as AdminOrgAssignmentRow[]),
        fetchRequireIsuEmail().catch(() => true),
      ]);
      colleges.value = collegeRows;
      orgAssignments.value = assignments;
      requireIsuEmail.value = isuRequired;
      prefillCollegeAndOrganizationByName();
    } catch {
      colleges.value = [];
      orgAssignments.value = [];
      requireIsuEmail.value = true;
    } finally {
      loadingOptions.value = false;
    }
  },
);

watch(role, () => {
  if (!requiresCollege.value) {
    collegeId.value = "";
    programId.value = "";
    organizationId.value = "";
    return;
  }
  if (!requiresProgram.value) programId.value = "";
  if (!requiresOrganization.value) organizationId.value = "";
});

watch(collegeId, () => {
  if (!programOptions.value.some((program) => program.id === programId.value)) {
    programId.value = "";
  }
});

watch(programId, () => {
  if (!organizationOptions.value.some((org) => org.id === organizationId.value)) {
    organizationId.value = "";
  }
});

async function submitEdit(e: Event) {
  e.preventDefault();
  if (!props.user || saving.value) return;
  if (!name.value.trim()) {
    ui.pushToast("Missing fields", "Full name is required.", "error");
    return;
  }
  if (!email.value.trim() || email.value.trim() === "—") {
    ui.pushToast("Missing email", "A valid email is required.", "error");
    return;
  }
  if (!emailMeetsAdminPolicy(email.value, requireIsuEmail.value)) {
    ui.pushToast(
      "Invalid email",
      requireIsuEmail.value ? ISU_EMAIL_ERROR : EMAIL_FORMAT_ERROR,
      "error",
    );
    return;
  }
  if (requiresCollege.value && !collegeId.value) {
    ui.pushToast("Missing fields", "Select a college for this role.", "error");
    return;
  }
  if (requiresProgram.value && !programId.value) {
    ui.pushToast("Missing fields", "Select a program for this role.", "error");
    return;
  }
  if (requiresOrganization.value && !organizationId.value) {
    ui.pushToast("Missing fields", "Select an organization for this role.", "error");
    return;
  }

  saving.value = true;
  try {
    await updatePortalUser({
      userId: props.user.userId,
      role: role.value,
      email: email.value.trim(),
      displayName: name.value.trim(),
      collegeId: collegeId.value || null,
      programId: programId.value || null,
      organizationId: organizationId.value || null,
    });
    const emailChanged = email.value.trim().toLowerCase() !== props.user.email.trim().toLowerCase();
    ui.pushToast(
      "User updated",
      emailChanged
        ? `Saved. This account now signs in with ${email.value.trim()}.`
        : "Account details were saved.",
      "success",
    );
    emit("updated");
    emit("close");
  } catch (err) {
    ui.pushToast("Update failed", err instanceof Error ? err.message : "Could not update account.", "error");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby="edit-user-title"
  >
    <div class="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white shadow-xl">
      <div class="sticky top-0 z-10 flex items-center justify-between border-b border-gray-200 bg-white px-6 py-4">
        <h2 id="edit-user-title" class="text-xl font-semibold text-gray-900">Edit User Details</h2>
        <button
          type="button"
          class="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100"
          aria-label="Close"
          @click="emit('close')"
        >
          <X class="h-5 w-5" />
        </button>
      </div>

      <div class="space-y-4 p-6">
        <div class="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950">
          <p class="font-semibold">Update account assignment</p>
          <p class="mt-1 text-sky-900/90">
            A dean stays on a college. An adviser stays on a program. A student officer stays on an organization.
          </p>
        </div>

        <div
          v-if="role === 'dean'"
          class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          Each college may have only one active Dean. Changing college will fail if that college already has another Dean.
        </div>

        <div
          v-if="user?.appRole === LEGACY_STUDENT_ROLE"
          class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          This account has the deprecated <strong>{{ adminRoleLabel(LEGACY_STUDENT_ROLE) }}</strong> role. Assign a
          portal role below to restore staff access.
        </div>

        <form class="space-y-4" @submit="submitEdit">
          <div>
            <label class="mb-2 block text-sm font-medium text-gray-700">Role <span class="text-red-500">*</span></label>
            <select
              v-model="role"
              required
              class="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option v-for="opt in roleOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </div>

          <div
            v-if="role === 'student_officer' && selectedOrgOfficer"
            class="rounded-lg border border-amber-200 bg-amber-50 p-4"
          >
            <p class="text-sm text-amber-900">
              <strong>Note:</strong> This organization already has a Student Officer:
              {{ selectedOrgOfficer }}.
            </p>
          </div>

          <div v-if="requiresCollege">
            <label class="mb-2 block text-sm font-medium text-gray-700">College <span class="text-red-500">*</span></label>
            <select
              v-model="collegeId"
              required
              class="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Select college</option>
              <option v-for="c in colleges" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
            <p v-if="loadingOptions" class="mt-1 text-xs text-slate-500">Loading colleges...</p>
          </div>

          <div v-if="requiresProgram">
            <label class="mb-2 block text-sm font-medium text-gray-700">
              Program <span class="text-red-500">*</span>
            </label>
            <select
              v-model="programId"
              required
              :disabled="!collegeId"
              class="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
            >
              <option value="">{{ collegeId ? "Select program" : "Select college first" }}</option>
              <option v-for="program in programOptions" :key="program.id" :value="program.id">
                {{ program.name }}
              </option>
            </select>
          </div>

          <div v-if="requiresOrganization">
            <label class="mb-2 block text-sm font-medium text-gray-700">
              Organization <span class="text-red-500">*</span>
            </label>
            <select
              v-model="organizationId"
              required
              :disabled="!programId"
              class="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
            >
              <option value="">{{ programId ? "Select organization" : "Select program first" }}</option>
              <option v-for="org in organizationOptions" :key="org.id" :value="org.id">
                {{ organizationOptionLabel(org.id, org.name) }}
              </option>
            </select>
          </div>

          <div>
            <label class="mb-2 block text-sm font-medium text-gray-700">
              Full Name <span class="text-red-500">*</span>
            </label>
            <input
              v-model="name"
              type="text"
              required
              class="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label class="mb-2 block text-sm font-medium text-gray-700">
              Email <span class="text-red-500">*</span>
            </label>
            <input
              v-model="email"
              type="text"
              required
              :placeholder="requireIsuEmail ? 'user@isu.edu.ph' : 'user@email.com'"
              class="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p class="mt-1 text-xs text-gray-500">
              {{
                requireIsuEmail
                  ? "Official ISU email required (@isu.edu.ph). The user will sign in with this address."
                  : "Any valid email address is allowed. The user will sign in with this address."
              }}
            </p>
          </div>

          <div class="flex gap-3 pt-4">
            <button
              type="submit"
              :disabled="saving"
              class="flex-1 rounded-lg bg-blue-600 px-4 py-3 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ saving ? "Saving..." : "Save Changes" }}
            </button>
            <button
              type="button"
              class="rounded-lg bg-gray-200 px-6 py-3 text-gray-700 transition-colors hover:bg-gray-300"
              @click="emit('close')"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
