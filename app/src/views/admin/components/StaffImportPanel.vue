<script setup lang="ts">
import { computed, ref } from "vue";
import { Download, FileSpreadsheet, Upload } from "lucide-vue-next";
import StatusBadge from "@/components/portal/StatusBadge.vue";
import { fetchStaffImportCatalog, importStaffAccounts, type StaffImportRowResult } from "@/services/staffImportDb";
import {
  STAFF_IMPORT_MAX_BYTES,
  STAFF_IMPORT_MAX_ROWS,
  downloadStaffTemplate,
  parseStaffCsv,
  parseStaffXlsx,
  staffImportCanConfirm,
  staffRoleLabel,
  validateStaffImportRows,
  type StaffImportKind,
  type StaffImportPreviewRow,
  type StaffImportRow,
} from "@/services/staffImportParser";
import { useUiStore } from "@/stores/ui";
import { toUserFacingError } from "@/utils/userFacingError";

const props = defineProps<{ kind: StaffImportKind }>();
const emit = defineEmits<{ imported: [] }>();
const ui = useUiStore();
const fileInput = ref<HTMLInputElement | null>(null);
const previewRows = ref<StaffImportPreviewRow[]>([]);
const resultRows = ref<StaffImportRowResult[]>([]);
const parsing = ref(false);
const importing = ref(false);
const summary = ref<string | null>(null);

const label = computed(() => staffRoleLabel(props.kind));
const showOrganization = computed(() => props.kind === "adviser");
const canConfirm = computed(() => staffImportCanConfirm(previewRows.value) && !importing.value && !parsing.value);

function statusTone(status: string) {
  if (status === "Valid" || status === "Success") return "success" as const;
  if (status === "Duplicate" || status === "Skipped") return "info" as const;
  if (status === "Warning") return "warning" as const;
  return "danger" as const;
}

function triggerUpload() {
  fileInput.value?.click();
}

function downloadTemplate() {
  downloadStaffTemplate(props.kind);
  ui.pushToast("Template downloaded", "Replace the EXAMPLE row before uploading. Example rows are not imported.", "info");
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  previewRows.value = [];
  resultRows.value = [];
  summary.value = null;
  if (file.size > STAFF_IMPORT_MAX_BYTES) {
    ui.pushToast("File too large", "Use a CSV or XLSX file smaller than 1 MB.", "error");
    return;
  }
  parsing.value = true;
  try {
    const name = file.name.toLowerCase();
    let parsed: StaffImportRow[];
    if (name.endsWith(".csv")) parsed = parseStaffCsv(await file.text(), props.kind);
    else if (name.endsWith(".xlsx")) parsed = await parseStaffXlsx(await file.arrayBuffer(), props.kind);
    else if (name.endsWith(".xls")) {
      ui.pushToast("Legacy XLS is not supported", "Save as XLSX or CSV and upload again.", "error");
      return;
    } else {
      ui.pushToast("Unsupported file", "Use CSV or XLSX.", "error");
      return;
    }
    if (parsed.length > STAFF_IMPORT_MAX_ROWS) {
      ui.pushToast("Too many rows", `Import at most ${STAFF_IMPORT_MAX_ROWS} ${label.value}s at a time.`, "error");
      return;
    }
    const catalog = await fetchStaffImportCatalog();
    previewRows.value = validateStaffImportRows(parsed, catalog, props.kind);
    if (!previewRows.value.length) {
      ui.pushToast("Nothing to import", "No data rows were found. Example rows are skipped.", "info");
      return;
    }
    const invalid = previewRows.value.filter((r) => r.status === "Invalid").length;
    ui.pushToast(
      "Import preview ready",
      invalid
        ? `${previewRows.value.length} row(s) parsed. ${invalid} cannot be imported.`
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
  if (!canConfirm.value) return;
  importing.value = true;
  try {
    const result = await importStaffAccounts(props.kind, previewRows.value);
    resultRows.value = result.rows;
    summary.value = `${label.value} Import Complete. Total rows: ${result.total}. Successful: ${result.successful}. Failed: ${result.failed}. Skipped: ${result.skipped}. Invitations sent: ${result.invitations}.`;
    ui.pushToast(
      result.failed ? "Import finished with errors" : "Import completed",
      summary.value,
      result.failed ? "warning" : "success",
    );
    previewRows.value = [];
    emit("imported");
  } catch (err) {
    summary.value = `Import failed. ${toUserFacingError(err, "Some rows may not have been processed.")}`;
    ui.pushToast("Import failed", toUserFacingError(err, "Try again after checking the preview."), "error");
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <section
    class="dash-card min-w-0 p-3"
    :class="previewRows.length || resultRows.length ? 'md:col-span-3' : ''"
  >
    <h2 class="text-sm font-bold text-slate-900">{{ label }}s</h2>
    <p class="mt-1 text-xs text-slate-600">
      Invite {{ label.toLowerCase() }}s from a spreadsheet. No passwords.
      {{ kind === "dean" ? "One Dean per college." : "Advisers belong to a program. A program can have more than one adviser." }}
    </p>
    <input ref="fileInput" type="file" accept=".csv,.xlsx,.xls" class="sr-only" @change="onFile" />
    <div class="mt-3 flex flex-col gap-1.5">
      <button type="button" class="portal-btn-secondary w-full justify-center text-xs" @click="downloadTemplate">
        <Download class="h-3.5 w-3.5" />
        Download Template
      </button>
      <button type="button" class="portal-btn w-full justify-center text-xs" :disabled="parsing || importing" @click="triggerUpload">
        <Upload class="h-3.5 w-3.5" />
        {{ parsing ? "Reading…" : "Upload File" }}
      </button>
      <button type="button" class="portal-btn w-full justify-center text-xs" :disabled="!canConfirm" @click="confirmImport">
        <FileSpreadsheet class="h-3.5 w-3.5" />
        {{ importing ? "Importing…" : "Confirm import" }}
      </button>
    </div>
    <p v-if="summary" class="mt-3 text-sm text-slate-700">{{ summary }}</p>

    <div v-if="previewRows.length" class="mt-4 overflow-x-auto">
      <table class="portal-table min-w-[880px]">
        <thead>
          <tr>
            <th>Row</th>
            <th>Name</th>
            <th>Email</th>
            <th>College</th>
            <th v-if="showOrganization">Program</th>
            <th>Position</th>
            <th>Status</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in previewRows" :key="`p-${kind}-${row.row}-${row.email}`">
            <td class="font-mono text-xs">{{ row.row }}</td>
            <td>{{ row.fullName || "—" }}</td>
            <td class="text-xs">{{ row.email || "—" }}</td>
            <td>{{ row.college || "—" }}</td>
            <td v-if="showOrganization">{{ row.program || "—" }}</td>
            <td>{{ row.position || "—" }}</td>
            <td><StatusBadge :label="row.status" :tone="statusTone(row.status)" /></td>
            <td class="text-xs text-slate-600">{{ row.message }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else-if="resultRows.length" class="mt-4 overflow-x-auto">
      <table class="portal-table min-w-[880px]">
        <thead>
          <tr>
            <th>Row</th>
            <th>Name</th>
            <th>Email</th>
            <th>College</th>
            <th v-if="showOrganization">Program</th>
            <th>Position</th>
            <th>Status</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in resultRows" :key="`r-${kind}-${row.row}-${row.email}`">
            <td class="font-mono text-xs">{{ row.row }}</td>
            <td>{{ row.full_name || "—" }}</td>
            <td class="text-xs">{{ row.email || "—" }}</td>
            <td>{{ row.college || "—" }}</td>
            <td v-if="showOrganization">{{ row.organization || "—" }}</td>
            <td>{{ row.position || "—" }}</td>
            <td><StatusBadge :label="row.status" :tone="statusTone(row.status)" /></td>
            <td class="text-xs text-slate-600">{{ row.message }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
