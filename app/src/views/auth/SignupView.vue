<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter, RouterLink } from "vue-router";
import { CheckCircle2, Eye, EyeOff, GraduationCap, Hash, Lock, Mail } from "lucide-vue-next";
import AuthDevNotice from "@/components/auth/AuthDevNotice.vue";
import { useAuthStore } from "@/stores/auth";
import { useProfileStore } from "@/stores/profile";
import { useUiStore } from "@/stores/ui";
import { isValidStudentIdFormat, normalizeStudentId } from "@/types/studentRegistry";

const router = useRouter();
const auth = useAuthStore();
const profile = useProfileStore();
const ui = useUiStore();

const step = ref<1 | 2 | "confirm-email">(1);
const studentId = ref("");
const password = ref("");
const confirm = ref("");
const accountEmail = ref("");
const showPassword = ref(false);
const loading = ref(false);
const verifyError = ref("");
const formError = ref("");

const normalizedId = computed(() => normalizeStudentId(studentId.value));
const matched = ref<import("@/types/studentRegistry").MasterStudent | null>(null);

watch(studentId, () => {
  verifyError.value = "";
});

watch([password, confirm, accountEmail], () => {
  formError.value = "";
});

async function verifyId() {
  verifyError.value = "";
  if (!isValidStudentIdFormat(normalizedId.value)) {
    verifyError.value = "Student ID must look like 23-0668 (YY-XXXX).";
    return;
  }
  loading.value = true;
  try {
    const ok = await auth.verifyStudentRegistry(normalizedId.value);
    if (!ok) {
      verifyError.value =
        "This ID is not in the master student registry. Contact the registrar if this is a mistake.";
      return;
    }
    const row = await auth.fetchRegistryRow(normalizedId.value);
    if (!row) {
      verifyError.value = "Registry row could not be loaded. Try again.";
      return;
    }
    matched.value = {
      id: row.studentId,
      studentId: row.studentId,
      fullName: row.fullName,
      course: row.college ?? "",
      program: row.program ?? "",
      yearLevel: "",
      email: row.email,
    };
    step.value = 2;
    if (!accountEmail.value && row.email) {
      accountEmail.value = row.email;
    }
  } catch {
    verifyError.value = "Could not verify your ID. Check your connection and try again.";
  } finally {
    loading.value = false;
  }
}

async function register() {
  formError.value = "";
  if (!matched.value) {
    formError.value = "Verification expired. Go back and confirm your student ID.";
    return;
  }
  if (!accountEmail.value.trim()) {
    formError.value = "Enter an email for your account.";
    return;
  }
  if (password.value.length < 8) {
    formError.value = "Password must be at least 8 characters.";
    return;
  }
  if (password.value !== confirm.value) {
    formError.value = "Passwords do not match.";
    return;
  }
  loading.value = true;
  try {
    const { needsEmailConfirmation } = await auth.signUp({
      email: accountEmail.value.trim(),
      password: password.value,
      studentId: normalizedId.value,
      fullName: matched.value.fullName,
    });

    if (needsEmailConfirmation) {
      step.value = "confirm-email";
      ui.pushToast(
        "Confirm your email",
        "We sent a confirmation link. You must confirm before you can sign in or open your profile.",
        "info",
      );
      return;
    }

    profile.setFromAuth(matched.value.fullName, accountEmail.value.trim(), "student");
    ui.pushToast("Account ready", "You are verified against the student registry.", "success");
    await router.push("/student");
  } catch (e) {
    formError.value = e instanceof Error ? e.message : "Registration failed. Try again.";
  } finally {
    loading.value = false;
  }
}

const resendLoading = ref(false);

async function resendConfirmation() {
  if (!accountEmail.value.trim()) return;
  resendLoading.value = true;
  try {
    await auth.resendSignupConfirmation(accountEmail.value.trim());
    ui.pushToast("Email sent", "Check your inbox and spam folder for the confirmation link.", "success");
  } catch (e) {
    ui.pushToast("Could not resend", e instanceof Error ? e.message : "Try again later.", "error");
  } finally {
    resendLoading.value = false;
  }
}
</script>

<template>
  <div class="portal-root flex min-h-dvh flex-col">
    <div class="flex flex-1 flex-col items-center justify-center px-3 py-10 sm:px-4">
      <div class="mb-6 text-center">
        <div
          class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-lg ring-2 ring-white/30"
        >
          <GraduationCap class="h-7 w-7" />
        </div>
        <h1 class="text-2xl font-bold tracking-tight text-slate-900">EventLink</h1>
        <p class="mt-1 text-sm text-slate-600">Student registration</p>
      </div>

      <div class="auth-glass-card w-full max-w-md">
        <Transition
          mode="out-in"
          enter-active-class="transition duration-200 ease-out"
          enter-from-class="opacity-0 translate-y-1"
          enter-to-class="opacity-100 translate-y-0"
          leave-active-class="transition duration-150 ease-in"
          leave-from-class="opacity-100 translate-y-0"
          leave-to-class="opacity-0 -translate-y-1"
        >
          <div v-if="step === 1" key="verify">
            <h2 class="text-lg font-semibold text-slate-900">Verify student ID</h2>
            <p class="mt-1 text-sm text-slate-600">
              Your ID must exist in the registry uploaded by administrators.
            </p>

            <div class="mt-6 space-y-4">
              <div>
                <label class="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500" for="sid"
                  >Student ID</label
                >
                <div class="relative">
                  <Hash class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="sid"
                    v-model="studentId"
                    type="text"
                    class="portal-input pl-10 font-mono uppercase"
                    placeholder="23-0668"
                    autocomplete="off"
                  />
                </div>
              </div>
              <p v-if="verifyError" class="text-sm font-medium text-red-700">{{ verifyError }}</p>
              <button type="button" class="portal-btn w-full" @click="verifyId">
                <CheckCircle2 class="h-4 w-4" />
                Validate against registry
              </button>
            </div>
          </div>

          <div v-else-if="step === 'confirm-email'" key="confirm">
            <h2 class="text-lg font-semibold text-slate-900">Confirm your email</h2>
            <p class="mt-2 text-sm text-slate-600">
              Your account was created for <strong>{{ accountEmail }}</strong
              >. Supabase sent a confirmation link — open it, then
              <RouterLink to="/login" class="font-semibold text-emerald-700 hover:underline">sign in</RouterLink>.
            </p>
            <p class="mt-2 text-sm text-slate-600">
              Until you confirm, <strong>My profile</strong> and other signed-in pages will not work.
            </p>
            <div class="mt-6 flex flex-col gap-2">
              <button type="button" class="portal-btn w-full" :disabled="resendLoading" @click="resendConfirmation">
                {{ resendLoading ? "Sending…" : "Resend confirmation email" }}
              </button>
              <RouterLink to="/student" class="portal-btn-secondary w-full text-center">
                Browse events (no sign-in)
              </RouterLink>
            </div>
          </div>

          <div v-else key="account">
            <h2 class="text-lg font-semibold text-slate-900">Create your account</h2>
            <p class="mt-1 text-sm text-slate-600">Registry match: {{ matched?.fullName }} ({{ normalizedId }})</p>

            <form class="mt-6 space-y-4" @submit.prevent="register">
              <div>
                <label class="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500" for="semail"
                  >Email</label
                >
                <div class="relative">
                  <Mail class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="semail"
                    v-model="accountEmail"
                    type="text"
                    autocomplete="email"
                    class="portal-input pl-10"
                    placeholder="you@university.edu"
                  />
                </div>
              </div>

              <div>
                <label class="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500" for="spw"
                  >Password</label
                >
                <div class="relative">
                  <Lock class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="spw"
                    v-model="password"
                    :type="showPassword ? 'text' : 'password'"
                    autocomplete="new-password"
                    class="portal-input pl-10 pr-11"
                  />
                  <button
                    type="button"
                    class="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-slate-500 hover:bg-slate-100"
                    @click="showPassword = !showPassword"
                  >
                    <EyeOff v-if="showPassword" class="h-4 w-4" />
                    <Eye v-else class="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div>
                <label class="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500" for="scpw"
                  >Confirm password</label
                >
                <input
                  id="scpw"
                  v-model="confirm"
                  :type="showPassword ? 'text' : 'password'"
                  autocomplete="new-password"
                  class="portal-input"
                />
              </div>

              <p v-if="formError" class="text-sm font-medium text-red-700">{{ formError }}</p>

              <div class="flex flex-col gap-2 sm:flex-row sm:justify-between">
                <button type="button" class="portal-btn-secondary order-2 sm:order-1" @click="step = 1">
                  Back
                </button>
                <button type="submit" class="portal-btn order-1 flex-1 sm:order-2" :disabled="loading">
                  {{ loading ? "Creating…" : "Finish registration" }}
                </button>
              </div>
            </form>
          </div>
        </Transition>

        <p class="mt-6 text-center text-sm text-slate-600">
          Already have access?
          <RouterLink to="/login" class="font-semibold text-emerald-700 hover:underline">Sign in</RouterLink>
        </p>

        <AuthDevNotice />
      </div>
    </div>
  </div>
</template>
