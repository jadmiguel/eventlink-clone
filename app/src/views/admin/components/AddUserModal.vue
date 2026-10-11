<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { X } from "lucide-vue-next";
import { useUiStore } from "@/stores/ui";
import { createPortalUser, AdminCreateUserError } from "@/services/adminCreateUser";
import { fetchCollegesWithOrganizations, type CollegeWithOrgs } from "@/services/collegesDb";
import {
  fetchAdminOrgAssignments,
  officerNamesByOrganizationId,
  type AdminOrgAssignmentRow,
} from "@/services/adminUsersDb";
import { fetchRequireIsuEmail } from "@/services/appSettingsDb";
import { isSupabaseConfigured } from "@/lib/supabase";
import { EMAIL_FORMAT_ERROR, ISU_EMAIL_ERROR, emailMeetsAdminPolicy } from "@/utils/isuEmail";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; created: [] }>();

const ui = useUiStore();

type RoleValue =
  | ""
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

const role = ref<RoleValue>("");
const name = ref("");
const email = ref("");
const password = ref("");
const collegeId = ref("");
const programId = ref("");
const organizationId = ref("");
const creating = ref(false);
const loadingOptions = ref(false);
const colleges = ref<CollegeWithOrgs[]>([]);
const orgAssignments = ref<AdminOrgAssignmentRow[]>([]);
const requireIsuEmail = ref(true);

const roleOptions: Array<{ label: string; value: Exclude<RoleValue, ""> }> = [
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

const roleLabel = computed(() => roleOptions.find((r) => r.value === role.value)?.label ?? "");
const requiresCollege = computed(
  () => role.value === "student_officer" || role.value === "adviser" || role.value === "dean",
);
const requiresProgram = computed(
  () => role.value === "student_officer" || role.value === "adviser",
);
const requiresOrganization = computed(() => role.value === "student_officer");
const selectedCollege = computed(() => colleges.value.find((c) => c.id === collegeId.value) ?? null);
const programOptions = computed(() => selectedCollege.value?.programs ?? []);
const organizationOptions = computed(() => {
  const programs = selectedCollege.value?.programs ?? [];
  const selected = programs.find((program) => program.id === programId.value);
  return selected?.organizations ?? [];
});
const officerByOrgId = computed(() => officerNamesByOrganizationId(orgAssignments.value));
const selectedOrgOfficer = computed(() =>
  organizationId.value ? officerByOrgId.value.get(organizationId.value) ?? "" : "",
);

function organizationOptionLabel(orgId: string, orgName: string): string {
  const officer = officerByOrgId.value.get(orgId);
  return officer ? `${orgName} — Officer: ${officer}` : orgName;
}

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      if (isSupabaseConfigured) {
        loadingOptions.value = true;
        try {
          const [collegeRows, isuRequired, assignments] = await Promise.all([
            fetchCollegesWithOrganizations(),
            fetchRequireIsuEmail().catch(() => true),
            fetchAdminOrgAssignments().catch(() => [] as AdminOrgAssignmentRow[]),
          ]);
          colleges.value = collegeRows;
          requireIsuEmail.value = isuRequired;
          orgAssignments.value = assignments;
        } catch {
          colleges.value = [];
          requireIsuEmail.value = true;
          orgAssignments.value = [];
        } finally {
          loadingOptions.value = false;
        }
      }
      return;
    }

    role.value = "";
    name.value = "";
    email.value = "";
    password.value = "";
    collegeId.value = "";
    programId.value = "";
    organizationId.value = "";
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

function classifyCreateUserFailure(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("isu email") || lower.includes("email")) return "validation";
  if (lower.includes("invalid role")) return "enum/role";
  if (lower.includes("already") || lower.includes("one ")) return "constraint";
  if (lower.includes("auth") || lower.includes("create auth") || lower.includes("password")) return "auth";
  if (lower.includes("profile")) return "profiles";
  if (lower.includes("user_roles") || lower.includes("role")) return "user_roles";
  if (lower.includes("rls") || lower.includes("policy") || lower.includes("permission")) return "rls";
  return "unknown";
}

async function handleSubmit(e: Event) {
  e.preventDefault();
  if (creating.value) return;
  if (!role.value) {
    ui.pushToast("Select a role", "Choose the staff role for this account.", "error");
    return;
  }
  if (!name.value.trim() || !email.value.trim() || !password.value.trim()) {
    ui.pushToast("Missing fields", "Name, email, and password are required.", "error");
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
  if (password.value.length < 8) {
    ui.pushToast("Weak password", "Use at least 8 characters.", "error");
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

  creating.value = true;
  try {
    await createPortalUser({
      role: role.value,
      email: email.value.trim(),
      password: password.value,
      displayName: name.value.trim(),
      collegeId: collegeId.value || null,
      programId: programId.value || null,
      organizationId: organizationId.value || null,
    });
    ui.pushToast("Account created", `${email.value.trim()} can now sign in.`, "success");
    emit("created");
    emit("close");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not create account.";
    const source =
      err instanceof AdminCreateUserError ? err.source : classifyCreateUserFailure(msg);
    console.error("[admin-create-user]", source, err);
    ui.pushToast("Creation failed", msg, "error");
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby="add-user-title"
  >
    <div class="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white shadow-xl">
      <div class="sticky top-0 z-10 flex items-center justify-between border-b border-gray-200 bg-white px-6 py-4">
        <h2 id="add-user-title" class="text-xl font-semibold text-gray-900">Add New User</h2>
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
          <p class="font-semibold">Create staff account</p>
          <p class="mt-1 text-sky-900/90">
            This form creates a real Supabase auth user and assigns the selected portal role.
            A dean is assigned to a college. An adviser is assigned to a program. A student officer is assigned to an organization.
          </p>
        </div>

        <form class="space-y-4" @submit="handleSubmit">
          <div>
            <label class="mb-2 block text-sm font-medium text-gray-700">
              Role <span class="text-red-500">*</span>
            </label>
            <select
              v-model="role"
              required
              class="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Select Role</option>
              <option v-for="opt in roleOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </div>

          <div
            v-if="role === 'osas' || role === 'eo' || role === 'gso'"
            class="rounded-lg border border-yellow-200 bg-yellow-50 p-4"
          >
            <p class="text-sm text-yellow-800">
              <strong>Note:</strong> Only one {{ roleLabel }} account can exist in the system.
            </p>
          </div>

          <div
            v-if="role === 'dean'"
            class="rounded-lg border border-amber-200 bg-amber-50 p-4"
          >
            <p class="text-sm text-amber-900">
              <strong>Note:</strong> Each college may have only one active Dean. Select the college this Dean will manage.
            </p>
          </div>

          <div
            v-if="role === 'adviser'"
            class="rounded-lg border border-amber-200 bg-amber-50 p-4"
          >
            <p class="text-sm text-amber-900">
              <strong>Note:</strong> Advisers belong to a program. A program can have more than one adviser, and they review every organization in that program.
            </p>
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
            <label class="mb-2 block text-sm font-medium text-gray-700">
              College <span class="text-red-500">*</span>
            </label>
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
              placeholder="Juan dela Cruz"
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
                  ? "Official ISU email required (@isu.edu.ph)."
                  : "Any valid email address is allowed."
              }}
            </p>
          </div>

          <div>
            <label class="mb-2 block text-sm font-medium text-gray-700">
              Password <span class="text-red-500">*</span>
            </label>
            <input
              v-model="password"
              type="password"
              required
              placeholder="Min. 8 characters"
              class="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div class="flex gap-3 pt-4">
            <button
              type="submit"
              :disabled="creating"
              class="flex-1 rounded-lg bg-blue-600 px-4 py-3 text-white transition-colors hover:bg-blue-700"
            >
              {{ creating ? "Creating..." : "Create User" }}
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
