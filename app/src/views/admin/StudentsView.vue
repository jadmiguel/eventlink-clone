<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  Archive,
  ArchiveRestore,
  FileSpreadsheet,
  Pencil,
  Search,
  Upload,
} from "lucide-vue-next";
import PortalModal from "@/components/portal/PortalModal.vue";
import PortalEmptyState from "@/components/portal/PortalEmptyState.vue";
import StatusBadge from "@/components/portal/StatusBadge.vue";
import { useDebouncedRef } from "@/composables/useDebounce";
import { useStudentRegistryStore } from "@/stores/studentRegistry";
import { useUiStore } from "@/stores/ui";
import type { MasterStudent } from "@/types/studentRegistry";
import { normalizeStudentId } from "@/types/studentRegistry";
import { findDuplicateStudentIds, parseRegistryCsv, parseRegistryXlsx } from "@/services/studentRegistryParser";

const registry = useStudentRegistryStore();
const ui = useUiStore();

const searchRaw = ref("");
const searchDebounced = useDebouncedRef(searchRaw, 280);
const collegeFilter = ref("All");
const programFilter = ref("All");
const archiveTab = ref<"active" | "archived" | "all">("active");

const fileInput = ref<HTMLInputElement | null>(null);
const previewRows = ref<MasterStudent[]>([]);
const duplicateKeys = ref<string[]>([]);
const parsing = ref(false);

const editOpen = ref(false);
const editForm = ref<MasterStudent | null>(null);
const saving = ref(false);

onMounted(() => {
  if (registry.useSupabase) {
    registry.fetchAll().catch(() => {
      ui.pushToast("Registry load failed", registry.loadError ?? "Check Supabase connection.", "error");
    });
  }
});

const colleges = computed(() => {
  const s = new Set(registry.students.map((x) => x.course).filter(Boolean));
  return ["All", ...Array.from(s).sort()];
});
const programs = computed(() => {
  const s = new Set(registry.students.map((x) => x.program).filter(Boolean));
  return ["All", ...Array.from(s).sort()];
});

const filtered = computed(() => {
  const q = searchDebounced.value.trim().toLowerCase();
  return registry.students.filter((s) => {
    if (archiveTab.value === "active" && s.archived) return false;
    if (archiveTab.value === "archived" && !s.archived) return false;
    if (collegeFilter.value !== "All" && s.course !== collegeFilter.value) return false;
    if (programFilter.value !== "All" && s.program !== programFilter.value) return false;
    if (!q) return true;
    const hay = [s.studentId, s.fullName, s.email, s.course, s.program]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
});

const existingStudentIdSet = computed(
  () => new Set(registry.students.map((s) => normalizeStudentId(s.studentId)).filter(Boolean)),
);

const updatingIds = computed(() => {
  const overlap = new Set<string>();
  for (const row of previewRows.value) {
    const id = normalizeStudentId(row.studentId);
    if (id && existingStudentIdSet.value.has(id)) overlap.add(id);
  }
  return Array.from(overlap).sort();
});

function triggerUpload() {
  fileInput.value?.click();
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  parsing.value = true;
  previewRows.value = [];
  duplicateKeys.value = [];
  try {
    const name = file.name.toLowerCase();
    let rows: MasterStudent[] = [];
    if (name.endsWith(".csv")) {
      const text = await file.text();
      rows = parseRegistryCsv(text);
    } else if (name.endsWith(".xlsx")) {
      const buf = await file.arrayBuffer();
      rows = await parseRegistryXlsx(buf);
    } else if (name.endsWith(".xls")) {
      ui.pushToast(
        "Legacy XLS is not supported",
        "Save the workbook as XLSX or export it as CSV, then upload it again.",
        "error",
      );
      parsing.value = false;
      return;
    } else {
      ui.pushToast("Unsupported file", "Use CSV or XLSX.", "error");
      parsing.value = false;
      return;
    }
    previewRows.value = rows;
    const dups = findDuplicateStudentIds(rows);
    duplicateKeys.value = Array.from(dups.keys());
    if (duplicateKeys.value.length) {
      ui.pushToast("Duplicates in file", "Resolve duplicate student IDs before merging.", "warning");
    } else {
      const updates = updatingIds.value.length;
      ui.pushToast(
        "Import preview ready",
        updates
          ? `${rows.length} row(s) parsed. ${updates} existing student ID(s) will be updated.`
          : `${rows.length} row(s) parsed.`,
        "success",
      );
    }
  } catch (err) {
    console.error(err);
    ui.pushToast("Import failed", "Could not read that file.", "error");
  }
  parsing.value = false;
}

async function mergePreview() {
  if (duplicateKeys.value.length) {
    ui.pushToast("Fix duplicates", "Remove or fix duplicate IDs in the spreadsheet.", "error");
    return;
  }
  if (!previewRows.value.length) {
    ui.pushToast("Nothing to merge", "Upload a file first.", "info");
    return;
  }
  saving.value = true;
  try {
    await registry.mergeImport(previewRows.value);
    previewRows.value = [];
    duplicateKeys.value = [];
    ui.pushToast("Registry updated", "Students saved to Supabase.", "success");
  } catch {
    ui.pushToast("Merge failed", registry.loadError ?? "Could not save to database.", "error");
  } finally {
    saving.value = false;
  }
}

function openEdit(row: MasterStudent) {
  editForm.value = { ...row, email: row.email ?? "" };
  editOpen.value = true;
}

async function saveEdit() {
  if (!editForm.value) return;
  saving.value = true;
  try {
    await registry.updateStudent(editForm.value.studentId, { ...editForm.value });
    editOpen.value = false;
    ui.pushToast("Saved", "Student record updated.", "success");
  } catch {
    ui.pushToast("Save failed", "Could not update this student.", "error");
  } finally {
    saving.value = false;
  }
}

async function toggleArchive(row: MasterStudent) {
  try {
    await registry.setArchived(row.studentId, !row.archived);
    ui.pushToast(row.archived ? "Restored" : "Archived", `${row.studentId}`, "info");
  } catch {
    ui.pushToast("Update failed", "Could not change archive status.", "error");
  }
}
</script>

<template>
  <div class="dash-page">
    <header class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p class="portal-section-title">Administration</p>
        <h1 class="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Student registry</h1>
        <p class="mt-1 max-w-2xl text-sm text-slate-600">
          Upload CSV or XLSX master lists, preview rows, and merge into the Supabase student registry (used at signup).
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <input
          ref="fileInput"
          type="file"
          accept=".csv,.xlsx,.xls"
          class="sr-only"
          @change="onFile"
        />
        <button type="button" class="portal-btn-secondary text-sm" :disabled="parsing" @click="triggerUpload">
          <Upload class="h-4 w-4" />
          {{ parsing ? "Reading…" : "Upload CSV / XLSX" }}
        </button>
        <button
          type="button"
          class="portal-btn text-sm"
          :disabled="!previewRows.length || saving"
          @click="mergePreview"
        >
          <FileSpreadsheet class="h-4 w-4" />
          Merge preview
        </button>
      </div>
    </header>

    <section v-if="previewRows.length" class="dash-card mt-4 p-4 sm:p-5">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 class="text-sm font-bold text-slate-900">Import preview</h2>
        <p class="text-xs text-slate-600">{{ previewRows.length }} row(s)</p>
      </div>
      <p v-if="duplicateKeys.length" class="mt-2 text-sm font-medium text-amber-800">
        Duplicate student IDs in file:
        <span class="font-mono">{{ duplicateKeys.join(", ") }}</span>
      </p>
      <p v-else-if="updatingIds.length" class="mt-2 text-sm font-medium text-sky-800">
        Existing IDs that will be updated:
        <span class="font-mono">{{ updatingIds.slice(0, 12).join(", ") }}</span>
        <span v-if="updatingIds.length > 12"> (+{{ updatingIds.length - 12 }} more)</span>
      </p>
      <div class="portal-table-wrap mt-3 max-h-64">
        <table class="portal-table min-w-[640px]">
          <thead>
            <tr>
              <th>Student ID</th>
              <th>Name</th>
              <th>College</th>
              <th>Program</th>
              <th>Email</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in previewRows.slice(0, 50)" :key="i">
              <td class="font-mono text-xs">{{ r.studentId }}</td>
              <td>{{ r.fullName }}</td>
              <td>{{ r.course }}</td>
              <td>{{ r.program }}</td>
              <td class="text-xs text-slate-600">{{ r.email ?? "—" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="previewRows.length > 50" class="mt-2 text-xs text-slate-500">Showing first 50 preview rows.</p>
    </section>

    <section class="dash-card mt-4 p-4 sm:p-5">
      <p v-if="registry.loading" class="mb-3 text-sm text-slate-600">Loading registry from Supabase…</p>
      <p v-else-if="registry.loadError" class="mb-3 text-sm font-medium text-red-700">{{ registry.loadError }}</p>

      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div class="relative sm:col-span-2">
          <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input v-model="searchRaw" type="search" class="portal-input pl-10" placeholder="Search ID, name, email…" />
        </div>
        <select v-model="collegeFilter" class="portal-input" aria-label="Filter by college">
          <option v-for="c in colleges" :key="c" :value="c">{{ c === "All" ? "All colleges" : c }}</option>
        </select>
        <select v-model="programFilter" class="portal-input" aria-label="Filter by program">
          <option v-for="p in programs" :key="p" :value="p">{{ p === "All" ? "All programs" : p }}</option>
        </select>
        <div class="flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 sm:col-span-2 lg:col-span-1">
          <button
            type="button"
            class="flex-1 rounded-md px-2 py-1.5 text-xs font-semibold transition"
            :class="archiveTab === 'active' ? 'bg-white text-emerald-800 shadow-sm' : 'text-slate-600'"
            @click="archiveTab = 'active'"
          >
            Active
          </button>
          <button
            type="button"
            class="flex-1 rounded-md px-2 py-1.5 text-xs font-semibold transition"
            :class="archiveTab === 'archived' ? 'bg-white text-emerald-800 shadow-sm' : 'text-slate-600'"
            @click="archiveTab = 'archived'"
          >
            Archived
          </button>
          <button
            type="button"
            class="flex-1 rounded-md px-2 py-1.5 text-xs font-semibold transition"
            :class="archiveTab === 'all' ? 'bg-white text-emerald-800 shadow-sm' : 'text-slate-600'"
            @click="archiveTab = 'all'"
          >
            All
          </button>
        </div>
      </div>

      <div class="portal-table-wrap mt-4">
        <table class="portal-table">
          <thead>
            <tr>
              <th>Student ID</th>
              <th>Full name</th>
              <th>College</th>
              <th>Program</th>
              <th>Email</th>
              <th>Status</th>
              <th class="sticky right-0 z-20 min-w-[8rem] bg-white/95 text-right shadow-[-8px_0_12px_-8px_rgba(15,23,42,0.25)]">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in filtered" :key="row.id">
              <td class="font-mono text-xs">{{ normalizeStudentId(row.studentId) }}</td>
              <td class="font-medium text-slate-900">{{ row.fullName }}</td>
              <td>{{ row.course || "—" }}</td>
              <td class="max-w-[12rem] truncate">{{ row.program || "—" }}</td>
              <td class="max-w-[14rem] truncate text-xs text-slate-600">{{ row.email ?? "—" }}</td>
              <td>
                <StatusBadge :label="row.archived ? 'Archived' : 'Active'" :tone="row.archived ? 'neutral' : 'success'" />
              </td>
              <td
                class="sticky right-0 z-20 bg-white/95 px-3 text-right shadow-[-8px_0_12px_-8px_rgba(15,23,42,0.25)] sm:px-4"
              >
                <div class="inline-flex flex-wrap justify-end gap-1">
                  <button
                    type="button"
                    class="portal-btn-secondary px-2 py-1 text-xs"
                    :title="row.archived ? 'Restore' : 'Archive'"
                    @click="toggleArchive(row)"
                  >
                    <ArchiveRestore v-if="row.archived" class="h-3.5 w-3.5" />
                    <Archive v-else class="h-3.5 w-3.5" />
                  </button>
                  <button type="button" class="portal-btn px-2 py-1 text-xs" @click="openEdit(row)">
                    <Pencil class="h-3.5 w-3.5" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <PortalEmptyState
        v-if="!filtered.length"
        class="mt-4"
        title="No students match"
        description="Adjust filters, restore archived records, or merge a new import."
      />
    </section>

    <PortalModal v-model="editOpen" title="Edit student" size="md">
      <div v-if="editForm" class="space-y-3">
        <div>
          <label class="mb-1 block text-xs font-semibold text-slate-500">Student ID</label>
          <input v-model="editForm.studentId" type="text" class="portal-input font-mono uppercase" disabled />
        </div>
        <div>
          <label class="mb-1 block text-xs font-semibold text-slate-500">Full name</label>
          <input v-model="editForm.fullName" type="text" class="portal-input" />
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="mb-1 block text-xs font-semibold text-slate-500">College</label>
            <input v-model="editForm.course" type="text" class="portal-input" placeholder="e.g. CCSICT" />
          </div>
          <div>
            <label class="mb-1 block text-xs font-semibold text-slate-500">Program</label>
            <input v-model="editForm.program" type="text" class="portal-input" placeholder="e.g. BSIT" />
          </div>
        </div>
        <div>
          <label class="mb-1 block text-xs font-semibold text-slate-500">Email</label>
          <input v-model="editForm.email" type="text" class="portal-input" />
        </div>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <button type="button" class="portal-btn-secondary" @click="editOpen = false">Cancel</button>
          <button type="button" class="portal-btn" :disabled="saving" @click="saveEdit">
            {{ saving ? "Saving…" : "Save" }}
          </button>
        </div>
      </template>
    </PortalModal>
  </div>
</template>
