<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter, RouterLink } from "vue-router";
import { storeToRefs } from "pinia";
import { ArrowLeft, Bell, KeyRound, LogOut, Pencil, Save, X } from "lucide-vue-next";
import type { PortalRoleKey } from "@/types/portalProfile";
import { useProfileStore } from "@/stores/profile";
import { useAuthStore } from "@/stores/auth";
import { useUiStore } from "@/stores/ui";
import { isSupabaseConfigured } from "@/lib/supabase";
import ProfileHeader from "@/components/profile/ProfileHeader.vue";
import ProfileSectionCard from "@/components/profile/ProfileSectionCard.vue";
import ProfileField from "@/components/profile/ProfileField.vue";
import AvatarUpload from "@/components/profile/AvatarUpload.vue";
import ProfilePageSkeleton from "@/components/profile/ProfilePageSkeleton.vue";
import ProfileMyPostsSection from "@/components/profile/ProfileMyPostsSection.vue";

const route = useRoute();
const router = useRouter();
const profile = useProfileStore();
const auth = useAuthStore();
const ui = useUiStore();

const portalRole = computed(() => route.meta.portalRole as PortalRoleKey);
const standalone = computed(() => !!route.meta.profileStandalone);
const showMyPosts = computed(
  () => portalRole.value === "student-officer" || portalRole.value === "ssc",
);

const loading = ref(
  !(profile.lastFetchedAt > 0 || (profile.displayName && profile.displayName !== "Guest")),
);
const editMode = ref(false);
const saving = ref(false);
const avatarSaving = ref(false);
const pendingAvatarFile = ref<File | null | undefined>(undefined);

const { avatarDataUrl, notifyEmail, themePreference } = storeToRefs(profile);

const draft = reactive({
  displayName: "",
  email: "",
  phone: "",
  studentOrEmployeeId: "",
  course: "",
  program: "",
  yearLevel: "",
  organization: "",
  department: "",
  office: "",
  position: "",
});

function syncDraftFromStore() {
  draft.displayName = profile.displayName;
  draft.email = profile.email;
  draft.phone = profile.phone;
  draft.studentOrEmployeeId = profile.studentOrEmployeeId;
  draft.course = profile.course;
  draft.program = profile.program;
  draft.yearLevel = profile.yearLevel;
  draft.organization = profile.organization;
  draft.department = profile.department;
  draft.office = profile.office;
  draft.position = profile.position;
}

watch(editMode, (on) => {
  if (on) syncDraftFromStore();
});

/** Academic block for student officers only — not SSC or staff. */
const showAcademic = computed(() => portalRole.value === "student-officer");

onMounted(() => {
  const alreadyWarm =
    profile.lastFetchedAt > 0 || (profile.displayName && profile.displayName !== "Guest");
  if (alreadyWarm) {
    loading.value = false;
    syncDraftFromStore();
  }
  void profile.ensureHydrated(portalRole.value).finally(() => {
    loading.value = false;
    syncDraftFromStore();
  });
});

watch(portalRole, async (r) => {
  await profile.ensureHydrated(r);
  syncDraftFromStore();
});

const registryLinked = computed(
  () =>
    isSupabaseConfigured &&
    !auth.useMock &&
    !!auth.userId &&
    !!profile.studentOrEmployeeId &&
    showAcademic.value,
);

const usesSupabaseProfile = computed(
  () => isSupabaseConfigured && !auth.useMock && !!auth.userId,
);

async function saveProfile() {
  saving.value = true;
  try {
    await profile.persistPersonal(
      {
        ...draft,
        notifyEmail: notifyEmail.value,
        themePreference: themePreference.value,
        avatarFile: pendingAvatarFile.value,
        avatarPreviewUrl: avatarDataUrl.value,
      },
      portalRole.value,
    );
    pendingAvatarFile.value = undefined;
    editMode.value = false;
    syncDraftFromStore();
    ui.pushToast("Profile updated", "Your changes have been saved.", "success");
  } catch (e) {
    ui.pushToast(
      "Could not save profile",
      e instanceof Error ? e.message : "Try again.",
      "error",
    );
  } finally {
    saving.value = false;
  }
}

function cancelEdit() {
  editMode.value = false;
  pendingAvatarFile.value = undefined;
  syncDraftFromStore();
}

async function onAvatarFileSelected(file: File | null) {
  pendingAvatarFile.value = file;
  if (!usesSupabaseProfile.value) return;
  if (editMode.value) return; // when editing, avatar is saved together with other profile changes

  avatarSaving.value = true;
  try {
    await profile.persistPersonal(
      {
        avatarFile: file,
        avatarPreviewUrl: avatarDataUrl.value,
      },
      portalRole.value,
    );
    ui.pushToast("Photo updated", "Your profile photo was saved.", "success");
    pendingAvatarFile.value = undefined;
  } catch (e) {
    ui.pushToast(
      "Photo upload failed",
      e instanceof Error ? e.message : "Could not upload profile photo.",
      "error",
    );
  } finally {
    avatarSaving.value = false;
  }
}

async function onChangePassword() {
  const mail = (draft.email || profile.email || auth.email || "").trim();
  if (!mail) {
    ui.pushToast("No email on file", "Add an email to your account first.", "error");
    return;
  }
  if (auth.useMock || !isSupabaseConfigured) {
    ui.pushToast("Not available offline", "Connect Supabase to send a password reset link.", "info");
    return;
  }
  try {
    await auth.resetPassword(mail);
    ui.pushToast("Check your inbox", `Password reset link sent to ${mail}.`, "success");
  } catch (e) {
    ui.pushToast(
      "Could not send reset link",
      e instanceof Error ? e.message : "Try again.",
      "error",
    );
  }
}

async function onLogout() {
  await auth.signOut();
  profile.clear();
  ui.pushToast("Signed out", "See you next time.", "success");
  router.push("/login");
}

const emailEditable = computed(() => editMode.value);

/** Student-adjacent portals use the same tight header as standalone `/student/profile` (no tall hero card). */
const compactProfileHeader = computed(
  () => !standalone.value && (portalRole.value === "student-officer" || portalRole.value === "ssc"),
);
</script>

<template>
  <div :class="standalone ? 'portal-root flex min-h-dvh flex-col' : 'dash-page pb-8'">
    <header v-if="standalone" class="portal-topbar shrink-0">
      <div class="mx-auto flex w-full max-w-3xl items-center gap-2 px-3 py-2 sm:px-4">
        <RouterLink
          to="/events"
          class="portal-topbar-btn inline-flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium"
        >
          <ArrowLeft class="h-4 w-4" />
          <span class="hidden sm:inline">Events</span>
        </RouterLink>
        <span class="min-w-0 truncate text-sm font-semibold">My profile</span>
      </div>
    </header>

    <div :class="standalone ? 'portal-main-scroll min-h-0 flex-1' : ''">
      <div class="mx-auto w-full max-w-3xl px-3 py-4 sm:px-4 sm:py-6">
        <ProfilePageSkeleton v-if="loading" />

        <div v-else class="profile-fade space-y-4">
          <p
            v-if="profile.loadError"
            class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            {{ profile.loadError }}
          </p>

          <div v-if="!standalone" class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p class="portal-section-title">Account</p>
              <h1 class="text-xl font-bold text-slate-900 sm:text-2xl">My profile</h1>
            </div>
            <RouterLink
              v-if="portalRole === 'student-officer'"
              to="/events"
              class="portal-btn-secondary inline-flex w-full items-center justify-center px-3 py-2 text-xs sm:w-auto"
            >
              <ArrowLeft class="h-3.5 w-3.5" />
              Back to campus events
            </RouterLink>
          </div>

          <ProfileHeader :compact="compactProfileHeader" />

          <ProfileSectionCard title="Photo" description="Upload a profile image to save it to your account.">
            <AvatarUpload
              v-model="avatarDataUrl"
              :display-name="profile.displayName"
              @select-file="onAvatarFileSelected"
            />
            <p v-if="avatarSaving" class="mt-2 text-xs text-slate-500">Uploading photo...</p>
          </ProfileSectionCard>

          <ProfileSectionCard title="Personal information" description="Keep your contact details current.">
            <div class="grid gap-3 sm:grid-cols-2">
              <ProfileField v-model="draft.displayName" label="Full name" :editable="editMode" />
              <ProfileField
                v-model="draft.email"
                label="Email"
                input-type="text"
                :editable="emailEditable"
              />
              <ProfileField v-model="draft.phone" label="Contact number" input-type="tel" :editable="editMode" />
              <div class="sm:col-span-2">
                <ProfileField :model-value="profile.roleLabel" label="Role" :editable="false" />
              </div>
            </div>
            <p v-if="editMode && usesSupabaseProfile" class="mt-2 text-xs text-slate-500">
              Full name, email, and phone are saved to your account. Changing email may require confirmation from
              Supabase.
            </p>
          </ProfileSectionCard>

          <ProfileSectionCard
            v-if="showAcademic"
            title="Academic information"
            description="Shown on endorsements and student-facing workflows."
          >
            <div class="grid gap-3 sm:grid-cols-2">
              <ProfileField
                v-model="draft.course"
                label="College"
                :editable="editMode && !registryLinked"
              />
              <ProfileField
                v-model="draft.program"
                label="Program"
                :editable="editMode && !registryLinked"
              />
              <div class="sm:col-span-2">
                <ProfileField
                  v-model="draft.organization"
                  label="Organization (optional)"
                  :editable="editMode && !registryLinked"
                />
              </div>
            </div>
            <p v-if="registryLinked" class="mt-2 text-xs text-slate-500">
              College and program come from the student registry. Ask an administrator to update them if needed.
            </p>
          </ProfileSectionCard>

          <ProfileMyPostsSection v-if="showMyPosts" />

          <ProfileSectionCard title="Account settings">
            <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <button
                v-if="!editMode"
                type="button"
                class="portal-btn w-full sm:w-auto"
                @click="editMode = true"
              >
                <Pencil class="h-4 w-4" />
                Edit profile
              </button>
              <template v-else>
                <button type="button" class="portal-btn w-full sm:w-auto" :disabled="saving" @click="saveProfile">
                  <Save class="h-4 w-4" />
                  {{ saving ? "Saving…" : "Save changes" }}
                </button>
                <button
                  type="button"
                  class="portal-btn-secondary w-full sm:w-auto"
                  :disabled="saving"
                  @click="cancelEdit"
                >
                  <X class="h-4 w-4" />
                  Cancel
                </button>
              </template>
              <button type="button" class="portal-btn-secondary w-full sm:w-auto" @click="onChangePassword">
                <KeyRound class="h-4 w-4" />
                Change password
              </button>
              <button
                type="button"
                class="portal-btn w-full bg-gradient-to-r from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 sm:ml-auto sm:w-auto"
                @click="onLogout"
              >
                <LogOut class="h-4 w-4" />
                Logout
              </button>
            </div>

            <div class="mt-6 grid gap-4 border-t border-slate-100 pt-6 sm:grid-cols-2">
              <label
                class="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-slate-200/80 bg-slate-50/60 px-3 py-2.5 sm:px-4"
              >
                <span class="flex items-center gap-2 text-sm font-medium text-slate-800">
                  <Bell class="h-4 w-4 text-emerald-700" />
                  Email notifications
                </span>
                <input
                  v-model="notifyEmail"
                  type="checkbox"
                  class="h-4 w-4 rounded border-slate-300 text-emerald-600"
                />
              </label>
              <div>
                <p class="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">Theme</p>
                <select v-model="themePreference" class="portal-input text-sm">
                  <option value="system">System default</option>
                  <option value="light">Light</option>
                </select>
              </div>
            </div>
          </ProfileSectionCard>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.profile-fade {
  animation: profile-fade 0.35s ease-out both;
}
@keyframes profile-fade {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
