<script setup lang="ts">
import { ShieldCheck, Database, Bell, Mail } from "lucide-vue-next";
import { onMounted, ref } from "vue";
import { isSupabaseConfigured } from "@/lib/supabase";
import { fetchRequireIsuEmail, updateRequireIsuEmail } from "@/services/appSettingsDb";
import { useUiStore } from "@/stores/ui";
import { toUserFacingError } from "@/utils/userFacingError";

const ui = useUiStore();
const requireIsuEmail = ref(true);
const loading = ref(false);
const saving = ref(false);
const loadError = ref<string | null>(null);

async function loadSetting() {
  if (!isSupabaseConfigured) {
    loadError.value = "Supabase is not configured.";
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    requireIsuEmail.value = await fetchRequireIsuEmail();
  } catch (e) {
    loadError.value = toUserFacingError(e, "Could not load email setting.");
  } finally {
    loading.value = false;
  }
}

async function onRequireIsuChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const next = input.checked;
  if (saving.value || loading.value || next === requireIsuEmail.value) {
    input.checked = requireIsuEmail.value;
    return;
  }
  const previous = requireIsuEmail.value;
  requireIsuEmail.value = next;
  saving.value = true;
  try {
    await updateRequireIsuEmail(next);
    ui.pushToast(
      "Email setting saved",
      next
        ? "Only @isu.edu.ph addresses can be used for Admin-created accounts."
        : "Any valid email address can be used for Admin-created accounts.",
      "success",
    );
  } catch (e) {
    requireIsuEmail.value = previous;
    input.checked = previous;
    ui.pushToast("Could not save setting", toUserFacingError(e, "The previous value was restored."), "error");
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void loadSetting();
});

</script>

<template>
  <div class="dash-page">
    <div class="mb-6">
      <h1 class="text-3xl font-semibold text-gray-900">Settings</h1>
      <p class="text-sm text-slate-600">Live configuration and operational notes for production deployment.</p>
    </div>

    <section class="dash-card mb-4 p-5">
      <div class="mb-3 flex items-center gap-2">
        <Mail class="h-5 w-5 text-emerald-600" />
        <h2 class="text-base font-semibold text-slate-900">Account email policy</h2>
      </div>
      <div class="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="text-sm font-semibold text-slate-800">Require ISU Email Address</p>
            <p class="mt-1 text-xs text-slate-600">
              {{
                requireIsuEmail
                  ? "Only @isu.edu.ph email addresses can be used for Admin-created accounts."
                  : "Any valid email address can be used."
              }}
            </p>
            <p v-if="loading" class="mt-2 text-xs text-slate-500">Loading current setting…</p>
            <p v-else-if="loadError" class="mt-2 text-xs text-red-600">{{ loadError }}</p>
          </div>
          <label class="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              class="peer sr-only"
              :checked="requireIsuEmail"
              :disabled="loading || saving || !!loadError || !isSupabaseConfigured"
              @change="onRequireIsuChange"
            />
            <div
              class="h-6 w-11 rounded-full bg-slate-300 transition peer-checked:bg-emerald-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-emerald-300 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-slate-300 after:bg-white after:transition-all peer-checked:after:translate-x-full peer-disabled:opacity-50"
            />
          </label>
        </div>
        <p class="mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {{ requireIsuEmail ? "ON" : "OFF" }}
          <span v-if="saving" class="ml-2 font-medium normal-case tracking-normal text-slate-400">Saving…</span>
        </p>
      </div>
    </section>

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <section class="dash-card p-5">
        <div class="mb-3 flex items-center gap-2">
          <ShieldCheck class="h-5 w-5 text-emerald-600" />
          <h2 class="text-base font-semibold text-slate-900">Security Controls</h2>
        </div>
        <ul class="space-y-2 text-sm text-slate-700">
          <li>
            <strong>Sign-in:</strong> Email and password are enough. No email code is required.
          </li>
          <li>Admin-created users are created with email already confirmed (no verification link).</li>
          <li>Three failed password attempts trigger a 60-second lockout.</li>
          <li>Single active session enforcement is enabled for non-exempt email domains.</li>
          <li>New login security notifications are stored in-app.</li>
        </ul>
      </section>

      <section class="dash-card p-5">
        <div class="mb-3 flex items-center gap-2">
          <Bell class="h-5 w-5 text-blue-600" />
          <h2 class="text-base font-semibold text-slate-900">Operational Controls</h2>
        </div>
        <ul class="space-y-2 text-sm text-slate-700">
          <li>Create staff users from <span class="font-semibold">Admin - Users - Add user</span>.</li>
          <li>Reset credentials from the Users table action menu.</li>
          <li>College/organization setup is in <span class="font-semibold">Admin - Colleges</span>.</li>
        </ul>
      </section>

      <section class="dash-card p-5">
        <div class="mb-3 flex items-center gap-2">
          <Database class="h-5 w-5 text-violet-600" />
          <h2 class="text-base font-semibold text-slate-900">Deployment Notes</h2>
        </div>
        <ul class="space-y-2 text-sm text-slate-700">
          <li>Database backups and retention are managed from the Supabase dashboard.</li>
          <li>Edge function <code>admin-create-user</code> must be deployed for in-app account creation.</li>
          <li>Apply new SQL migrations before release to keep schema and UI aligned.</li>
        </ul>
      </section>
    </div>
  </div>
</template>
