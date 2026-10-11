<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Plus, ChevronDown, ChevronUp, Pencil, Trash2, Upload, Download, FileSpreadsheet } from "lucide-vue-next";
import { isSupabaseConfigured } from "@/lib/supabase";
import {
  assignOrganizationToProgram,
  createCollege,
  createOrganization,
  createProgram,
  deleteOrganization,
  deleteProgram,
  fetchCollegesWithOrganizations,
  updateCollege,
  type CollegeWithOrgs,
} from "@/services/collegesDb";
import { UNIVERSITY_WIDE_COLLEGE_CODE } from "@/services/organizationsDb";
import {
  adviserNamesByOrganizationId,
  fetchAdminOrgAssignments,
  fetchAdminPortalUsers,
  officerNamesByOrganizationId,
  type AdminOrgAssignmentRow,
  type AdminPortalUserRow,
} from "@/services/adminUsersDb";
import { importCollegesOrganizations } from "@/services/collegeOrgImportDb";
import {
  COLLEGE_ORG_IMPORT_MAX_BYTES,
  COLLEGE_ORG_IMPORT_MAX_ROWS,
  collegeOrgImportHasBlockers,
  downloadCollegeOrgTemplate,
  parseCollegeOrgCsv,
  parseCollegeOrgXlsx,
  validateCollegeOrgImportRows,
  type CollegeOrgImportPreviewRow,
} from "@/services/collegeOrgImportParser";
import StatusBadge from "@/components/portal/StatusBadge.vue";
import PortalListSkeleton from "@/components/portal/PortalListSkeleton.vue";
import { useUiStore } from "@/stores/ui";
import { toUserFacingError } from "@/utils/userFacingError";

const ui = useUiStore();
const colleges = ref<CollegeWithOrgs[]>([]);
const portalUsers = ref<AdminPortalUserRow[]>([]);
const orgAssignments = ref<AdminOrgAssignmentRow[]>([]);

const universityWide = computed(() =>
  colleges.value.find((c) => c.code === UNIVERSITY_WIDE_COLLEGE_CODE) ?? null,
);

const collegeList = computed(() =>
  colleges.value.filter((c) => c.code !== UNIVERSITY_WIDE_COLLEGE_CODE),
);

const deanByCollegeName = computed(() => {
  const map = new Map<string, string>();
  for (const u of portalUsers.value) {
    if (u.app_role !== "dean") continue;
    const college = u.college?.trim();
    if (!college || college === "—") continue;
    if (!map.has(college)) map.set(college, u.display_name);
  }
  return map;
});

const officerByOrgId = computed(() => officerNamesByOrganizationId(orgAssignments.value));
const adviserByOrgId = computed(() => adviserNamesByOrganizationId(orgAssignments.value));

function officerLabel(organizationId: string): string {
  return officerByOrgId.value.get(organizationId) || "Not assigned";
}

function adviserLabel(organizationId: string): string {
  return adviserByOrgId.value.get(organizationId) || "";
}

function advisersForProgram(collegeName: string, programName: string): string {
  const names = portalUsers.value
    .filter(
      (user) =>
        user.app_role === "adviser" &&
        user.college.trim().toLowerCase() === collegeName.trim().toLowerCase() &&
        user.program.trim().toLowerCase() === programName.trim().toLowerCase(),
    )
    .map((user) => user.display_name.trim())
    .filter(Boolean);
  return names.length ? names.join(", ") : "Not assigned";
}

const fileInput = ref<HTMLInputElement | null>(null);
const previewRows = ref<CollegeOrgImportPreviewRow[]>([]);
const parsing = ref(false);
const importing = ref(false);
const lastImportSummary = ref<string | null>(null);

function statusTone(status: CollegeOrgImportPreviewRow["status"]) {
  if (status === "Valid") return "success" as const;
  if (status === "Duplicate") return "info" as const;
  if (status === "Warning") return "warning" as const;
  return "danger" as const;
}

const previewBlockers = computed(() => collegeOrgImportHasBlockers(previewRows.value));
const previewInvalidCount = computed(() => previewRows.value.filter((r) => r.status === "Invalid").length);

function triggerUpload() {
  fileInput.value?.click();
}

function downloadTemplate() {
  downloadCollegeOrgTemplate();
  ui.pushToast(
    "Template downloaded",
    "Replace the EXAMPLE rows before uploading. Example rows are not imported.",
    "info",
  );
}

async function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;

  lastImportSummary.value = null;
  previewRows.value = [];

  if (file.size > COLLEGE_ORG_IMPORT_MAX_BYTES) {
    ui.pushToast("File too large", "Use a CSV or XLSX file smaller than 1 MB.", "error");
    return;
  }

  parsing.value = true;
  try {
    const name = file.name.toLowerCase();
    let parsed;
    if (name.endsWith(".csv")) {
      parsed = parseCollegeOrgCsv(await file.text());
    } else if (name.endsWith(".xlsx")) {
      parsed = await parseCollegeOrgXlsx(await file.arrayBuffer());
    } else if (name.endsWith(".xls")) {
      ui.pushToast(
        "Legacy XLS is not supported",
        "Save the workbook as XLSX or export it as CSV, then upload it again.",
        "error",
      );
      return;
    } else {
      ui.pushToast("Unsupported file", "Use CSV or XLSX.", "error");
      return;
    }

    const dataRows = parsed.filter((row) => row.collegeName || row.organizationName || row.organizationCode);
    if (dataRows.length > COLLEGE_ORG_IMPORT_MAX_ROWS) {
      ui.pushToast("Too many rows", `Import at most ${COLLEGE_ORG_IMPORT_MAX_ROWS} organizations at a time.`, "error");
      return;
    }

    const catalog = colleges.value.map((college) => ({
      name: college.name,
      organizations: college.organizations.map((org) => ({ name: org.name, slug: org.slug })),
    }));
    previewRows.value = validateCollegeOrgImportRows(parsed, catalog);

    if (!previewRows.value.length) {
      ui.pushToast("Nothing to import", "No data rows were found. Example rows are skipped.", "info");
      return;
    }

    const invalid = previewRows.value.filter((r) => r.status === "Invalid").length;
    ui.pushToast(
      "Import preview ready",
      invalid
        ? `${previewRows.value.length} row(s) parsed. ${invalid} need to be fixed before import.`
        : `${previewRows.value.length} row(s) parsed. Review the preview, then confirm.`,
      invalid ? "warning" : "success",
    );
  } catch (err) {
    console.error(err);
    ui.pushToast("Could not read file", toUserFacingError(err, "Use the downloadable template and try again."), "error");
  } finally {
    parsing.value = false;
  }
}

async function confirmImport() {
  if (importing.value || previewBlockers.value) return;
  importing.value = true;
  lastImportSummary.value = null;
  try {
    const result = await importCollegesOrganizations(previewRows.value);
    lastImportSummary.value = `Import completed. Colleges created: ${result.collegesCreated}. Organizations created: ${result.organizationsCreated}. Existing records reused: ${result.reused}. Failed rows: ${result.failed}.`;
    ui.pushToast("Import completed", lastImportSummary.value, "success");
    previewRows.value = [];
    await load();
  } catch (err) {
    lastImportSummary.value = `Import failed. No changes were applied. Reason: ${toUserFacingError(err, "Import failed. No changes were applied.")}`;
    ui.pushToast("Import failed", "No changes were applied.", "error");
  } finally {
    importing.value = false;
  }
}
const expandedCollege = ref<string | null>(null);
const newCollegeName = ref("");
const newCollegeCode = ref("");
const newOrgName = ref("");
const newProgramName = ref("");
const addingOrgFor = ref<string | null>(null);
const addingProgramFor = ref<string | null>(null);
const moveTargets = ref<Record<string, string>>({});
const editingCollegeId = ref<string | null>(null);
const editCollegeName = ref("");
const editCollegeCode = ref("");
const loading = ref(false);

async function load() {
  if (!isSupabaseConfigured) return;
  loading.value = true;
  try {
    const [collegeRows, users, assignments] = await Promise.all([
      fetchCollegesWithOrganizations(),
      fetchAdminPortalUsers().catch(() => [] as AdminPortalUserRow[]),
      fetchAdminOrgAssignments().catch(() => [] as AdminOrgAssignmentRow[]),
    ]);
    colleges.value = collegeRows;
    portalUsers.value = users;
    orgAssignments.value = assignments;
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());

function toggleCollege(id: string) {
  expandedCollege.value = expandedCollege.value === id ? null : id;
}

function startEditCollege(college: CollegeWithOrgs, ev: MouseEvent) {
  ev.stopPropagation();
  editingCollegeId.value = college.id;
  editCollegeName.value = college.name;
  editCollegeCode.value = college.code ?? "";
}

function cancelEditCollege() {
  editingCollegeId.value = null;
  editCollegeName.value = "";
  editCollegeCode.value = "";
}

async function saveEditCollege() {
  if (!editingCollegeId.value || !editCollegeName.value.trim()) return;
  try {
    await updateCollege(
      editingCollegeId.value,
      editCollegeName.value,
      editCollegeCode.value || editCollegeName.value.slice(0, 6),
    );
    cancelEditCollege();
    await load();
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e));
  }
}

async function addCollege() {
  if (!newCollegeName.value.trim()) return;
  try {
    await createCollege(newCollegeName.value, newCollegeCode.value || newCollegeName.value.slice(0, 6));
    newCollegeName.value = "";
    newCollegeCode.value = "";
    await load();
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e));
  }
}

async function addProgram(collegeId: string) {
  if (!newProgramName.value.trim()) return;
  try {
    await createProgram(collegeId, newProgramName.value);
    newProgramName.value = "";
    addingProgramFor.value = null;
    await load();
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e));
  }
}

async function removeProgram(id: string) {
  if (!window.confirm("Delete this program? Its organizations stay in the college until you assign them again.")) return;
  try {
    await deleteProgram(id);
    await load();
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e));
  }
}

async function addOrganization(collegeId: string, programId: string) {
  if (!newOrgName.value.trim()) return;
  try {
    await createOrganization(collegeId, newOrgName.value, undefined, programId);
    newOrgName.value = "";
    addingOrgFor.value = null;
    await load();
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e));
  }
}

async function moveOrganization(organizationId: string) {
  const programId = moveTargets.value[organizationId];
  if (!programId) return;
  try {
    await assignOrganizationToProgram(organizationId, programId);
    await load();
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e));
  }
}

async function removeOrg(id: string) {
  if (!window.confirm("Delete this organization?")) return;
  try {
    await deleteOrganization(id);
    await load();
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e));
  }
}
</script>

<template>
  <div class="p-8">
    <div class="mb-8">
      <h1 class="mb-2 text-3xl font-semibold text-gray-900">Colleges & organizations</h1>
      <p class="text-gray-600">
        A college has one dean and many programs. Each program has its advisers and its student organizations.
        Student officers belong to an organization. SSC stays university-wide and is listed separately.
      </p>
    </div>

    <div class="mb-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <h3 class="mb-1 font-semibold text-gray-900">College & organization import</h3>
      <p class="mb-4 text-sm text-gray-600">
        Download the template, fill college, program, and organization, then upload a CSV or XLSX. Example rows are skipped and nothing is saved until you confirm.
      </p>
      <input
        ref="fileInput"
        type="file"
        accept=".csv,.xlsx,.xls"
        class="sr-only"
        @change="onImportFile"
      />
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          @click="downloadTemplate"
        >
          <Download class="h-4 w-4" />
          Download Template
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          :disabled="parsing || importing"
          @click="triggerUpload"
        >
          <Upload class="h-4 w-4" />
          {{ parsing ? "Reading…" : "Upload File" }}
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="previewBlockers || importing || parsing"
          @click="confirmImport"
        >
          <FileSpreadsheet class="h-4 w-4" />
          {{ importing ? "Importing…" : "Confirm import" }}
        </button>
      </div>
      <p v-if="previewInvalidCount" class="mt-3 text-sm font-medium text-red-700">
        {{ previewInvalidCount }} invalid row(s). Fix the file before confirming.
      </p>
      <p v-if="lastImportSummary" class="mt-3 text-sm text-slate-700">{{ lastImportSummary }}</p>

      <div v-if="previewRows.length" class="mt-4 overflow-x-auto">
        <table class="min-w-[720px] w-full text-left text-sm">
          <thead>
            <tr class="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
              <th class="py-2 pr-3">Row</th>
              <th class="py-2 pr-3">College</th>
              <th class="py-2 pr-3">Program</th>
              <th class="py-2 pr-3">Organization</th>
              <th class="py-2 pr-3">Organization Code</th>
              <th class="py-2 pr-3">Status</th>
              <th class="py-2">Message</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in previewRows" :key="`${row.row}-${row.collegeName}-${row.organizationName}`" class="border-b border-gray-100">
              <td class="py-2 pr-3 font-mono text-xs">{{ row.row }}</td>
              <td class="py-2 pr-3">{{ row.collegeName || "—" }}</td>
              <td class="py-2 pr-3">{{ row.programName || "—" }}</td>
              <td class="py-2 pr-3">{{ row.organizationName || "—" }}</td>
              <td class="py-2 pr-3 font-mono text-xs">{{ row.organizationCode || "—" }}</td>
              <td class="py-2 pr-3">
                <StatusBadge :label="row.status" :tone="statusTone(row.status)" />
              </td>
              <td class="py-2 text-xs text-gray-600">{{ row.message }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="mb-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <h3 class="mb-4 font-semibold text-gray-900">Add college</h3>
      <div class="flex flex-col gap-3 sm:flex-row">
        <input
          v-model="newCollegeName"
          type="text"
          placeholder="College name"
          class="flex-1 rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <input
          v-model="newCollegeCode"
          type="text"
          placeholder="Code (e.g. CCSICT)"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 sm:w-40 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="button"
          class="flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700"
          @click="addCollege"
        >
          <Plus class="h-5 w-5" />
          Add
        </button>
      </div>
    </div>

    <PortalListSkeleton v-if="loading && !colleges.length" :rows="6" />
    <p v-else-if="loading" class="text-sm text-gray-500">Loading…</p>

    <div v-if="universityWide" class="mb-6 rounded-lg border border-purple-200 bg-purple-50/50 shadow-sm">
      <div class="border-b border-purple-100 px-6 py-4">
        <h3 class="text-lg font-semibold text-gray-900">{{ universityWide.name }}</h3>
        <p class="text-sm text-gray-600">
          University-wide body (not a college org). SSC events use this organization—not CCSICT student orgs.
        </p>
      </div>
      <ul class="divide-y divide-purple-100">
        <li
          v-for="org in universityWide.organizations"
          :key="org.id"
          class="flex items-center justify-between px-6 py-3"
        >
          <div class="min-w-0">
            <span class="font-medium text-gray-800">{{ org.name }}</span>
            <p class="mt-0.5 text-xs text-slate-500">
              Student Officer:
              <span class="font-medium text-slate-700">{{ officerLabel(org.id) }}</span>
              · Adviser:
              <span class="font-medium text-slate-700">{{ adviserLabel(org.id) }}</span>
            </p>
          </div>
          <span class="text-xs text-purple-700">SSC · slug: {{ org.slug || "ssc" }}</span>
        </li>
        <li v-if="!universityWide.organizations.length" class="px-6 py-4 text-sm text-gray-400">
          SSC organization data has not been configured yet.
        </li>
      </ul>
    </div>

    <div class="space-y-4">
      <div
        v-for="college in collegeList"
        :key="college.id"
        class="rounded-lg border border-gray-200 bg-white shadow-sm"
      >
        <div
          class="flex cursor-pointer items-center justify-between gap-4 px-6 py-4 hover:bg-gray-50"
          role="button"
          tabindex="0"
          @click="toggleCollege(college.id)"
        >
          <div class="min-w-0 flex-1">
            <template v-if="editingCollegeId === college.id">
              <div class="flex flex-col gap-2 sm:flex-row" @click.stop>
                <input
                  v-model="editCollegeName"
                  type="text"
                  class="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="College name"
                />
                <input
                  v-model="editCollegeCode"
                  type="text"
                  class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm sm:w-36 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Code"
                />
                <button
                  type="button"
                  class="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700"
                  @click="saveEditCollege"
                >
                  Save
                </button>
                <button
                  type="button"
                  class="rounded-lg bg-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-300"
                  @click="cancelEditCollege"
                >
                  Cancel
                </button>
              </div>
            </template>
            <template v-else>
              <h3 class="text-lg font-semibold text-gray-900">{{ college.name }}</h3>
              <p v-if="college.code" class="text-sm text-gray-600">Code: {{ college.code }}</p>
              <p class="mt-1 text-xs text-slate-500">
                Dean:
                <span class="font-medium text-slate-700">
                  {{ deanByCollegeName.get(college.name) || "Not assigned" }}
                </span>
              </p>
            </template>
          </div>
          <div class="flex shrink-0 items-center gap-2 sm:gap-4">
            <button
              v-if="editingCollegeId !== college.id"
              type="button"
              class="rounded-lg p-2 text-slate-600 hover:bg-slate-100"
              title="Edit college"
              @click="startEditCollege(college, $event)"
            >
              <Pencil class="h-4 w-4" />
            </button>
            <span class="rounded-full bg-sky-100 px-3 py-1 text-sm text-sky-800">
              {{ college.programs.length }} program{{ college.programs.length === 1 ? "" : "s" }}
            </span>
            <span class="rounded-full bg-green-100 px-3 py-1 text-sm text-green-800">
              {{ college.organizations.length }} org{{ college.organizations.length === 1 ? "" : "s" }}
            </span>
            <ChevronUp v-if="expandedCollege === college.id" class="h-5 w-5 text-gray-500" />
            <ChevronDown v-else class="h-5 w-5 text-gray-500" />
          </div>
        </div>

        <div v-if="expandedCollege === college.id" class="border-t border-gray-200">
          <div
            v-if="addingProgramFor === college.id"
            class="border-b border-gray-200 bg-sky-50 px-6 py-4"
          >
            <h4 class="mb-3 font-medium text-gray-900">New program</h4>
            <div class="flex flex-col gap-3 sm:flex-row">
              <input
                v-model="newProgramName"
                type="text"
                placeholder="Program name"
                class="flex-1 rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="button"
                class="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
                @click.stop="addProgram(college.id)"
              >
                Save
              </button>
              <button
                type="button"
                class="rounded-lg bg-gray-200 px-4 py-2 text-gray-700 hover:bg-gray-300"
                @click.stop="addingProgramFor = null"
              >
                Cancel
              </button>
            </div>
          </div>

          <div v-for="program in college.programs" :key="program.id" class="border-b border-gray-100">
            <div class="flex items-start justify-between gap-3 bg-slate-50 px-6 py-3">
              <div class="min-w-0">
                <p class="font-semibold text-gray-900">{{ program.name }}</p>
                <p class="mt-0.5 text-xs text-slate-500">
                  Advisers:
                  <span class="font-medium text-slate-700">{{ advisersForProgram(college.name, program.name) }}</span>
                </p>
              </div>
              <button
                type="button"
                class="rounded-lg p-2 text-red-600 hover:bg-red-50"
                title="Delete program"
                @click.stop="removeProgram(program.id)"
              >
                <Trash2 class="h-4 w-4" />
              </button>
            </div>

            <div
              v-if="addingOrgFor === program.id"
              class="border-t border-gray-200 bg-blue-50 px-6 py-4"
            >
              <h4 class="mb-3 font-medium text-gray-900">New organization in {{ program.name }}</h4>
              <div class="flex flex-col gap-3 sm:flex-row">
                <input
                  v-model="newOrgName"
                  type="text"
                  placeholder="Organization name"
                  class="flex-1 rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="button"
                  class="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
                  @click.stop="addOrganization(college.id, program.id)"
                >
                  Save
                </button>
                <button
                  type="button"
                  class="rounded-lg bg-gray-200 px-4 py-2 text-gray-700 hover:bg-gray-300"
                  @click.stop="addingOrgFor = null"
                >
                  Cancel
                </button>
              </div>
            </div>

            <ul class="divide-y divide-gray-100">
              <li
                v-for="org in program.organizations"
                :key="org.id"
                class="flex items-center justify-between px-6 py-3 pl-10 hover:bg-gray-50"
              >
                <div class="min-w-0">
                  <span class="font-medium text-gray-800">{{ org.name }}</span>
                  <p class="mt-0.5 text-xs text-slate-500">
                    Student Officer:
                    <span class="font-medium text-slate-700">{{ officerLabel(org.id) }}</span>
                    <template v-if="adviserLabel(org.id)">
                      · Previous adviser:
                      <span class="font-medium text-slate-700">{{ adviserLabel(org.id) }}</span>
                    </template>
                  </p>
                </div>
                <button
                  type="button"
                  class="rounded-lg p-2 text-red-600 hover:bg-red-50"
                  title="Delete organization"
                  @click.stop="removeOrg(org.id)"
                >
                  <Trash2 class="h-4 w-4" />
                </button>
              </li>
              <li v-if="!program.organizations.length" class="px-6 py-3 pl-10 text-sm text-gray-400">
                No organizations in this program yet.
              </li>
            </ul>
            <div class="px-6 py-3 pl-10">
              <button
                type="button"
                class="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                @click.stop="addingOrgFor = program.id"
              >
                <Plus class="h-4 w-4" />
                Add organization
              </button>
            </div>
          </div>

          <div v-if="college.unassignedOrganizations.length" class="border-b border-gray-100 px-6 py-4">
            <h4 class="text-sm font-semibold text-gray-900">No program yet</h4>
            <p class="mt-1 text-xs text-slate-500">
              These organizations were added before programs. Choose a program to place each one.
            </p>
            <ul class="mt-3 divide-y divide-gray-100">
              <li
                v-for="org in college.unassignedOrganizations"
                :key="org.id"
                class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div class="min-w-0">
                  <span class="font-medium text-gray-800">{{ org.name }}</span>
                  <p class="mt-0.5 text-xs text-slate-500">
                    Student Officer:
                    <span class="font-medium text-slate-700">{{ officerLabel(org.id) }}</span>
                  </p>
                </div>
                <div class="flex items-center gap-2">
                  <select
                    v-model="moveTargets[org.id]"
                    class="rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                    @click.stop
                  >
                    <option value="">Select program</option>
                    <option v-for="program in college.programs" :key="program.id" :value="program.id">
                      {{ program.name }}
                    </option>
                  </select>
                  <button
                    type="button"
                    class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                    :disabled="!moveTargets[org.id]"
                    @click.stop="moveOrganization(org.id)"
                  >
                    Assign
                  </button>
                </div>
              </li>
            </ul>
          </div>

          <div v-if="!college.programs.length && !college.unassignedOrganizations.length" class="px-6 py-4 text-sm text-gray-400">
            No programs yet. Add the programs in this college, then add organizations inside each program.
          </div>

          <div class="border-t border-gray-200 bg-gray-50 px-6 py-4">
            <button
              type="button"
              class="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
              @click.stop="addingProgramFor = college.id"
            >
              <Plus class="h-4 w-4" />
              Add program
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
