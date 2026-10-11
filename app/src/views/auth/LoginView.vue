<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter, RouterLink } from "vue-router";
import { Eye, EyeOff, GraduationCap, Lock, Mail, ShieldCheck, X } from "lucide-vue-next";
import { formatAuthError, useAuthStore } from "@/stores/auth";
import { useProfileStore } from "@/stores/profile";
import { useUiStore } from "@/stores/ui";
import { useNotificationsStore } from "@/stores/notifications";
import { usePageVisibility } from "@/composables/usePageVisibility";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const profile = useProfileStore();
const ui = useUiStore();
const notifications = useNotificationsStore();
const { visible: pageVisible } = usePageVisibility();

const email = ref("");
const password = ref("");
const showPassword = ref(false);
const loading = ref(false);
const error = ref("");
const showResendConfirm = ref(false);
const resendLoading = ref(false);
const failedPasswordAttempts = ref(0);
const lockedUntilMs = ref(0);
const nowMs = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;
const MAX_FAILED_PASSWORD_ATTEMPTS = 3;
const LOCKOUT_MS = 60 * 1000;
const LOCKOUT_KEY_PREFIX = "eventlink:login-lockout:";
const NEW_USER_HINT_KEY = "eventlink:dismissed-new-user-hint";
const showNewUserHint = ref(false);

const lockRemainingSeconds = computed(() =>
  Math.max(0, Math.ceil((lockedUntilMs.value - nowMs.value) / 1000)),
);
const isPasswordLocked = computed(() => lockRemainingSeconds.value > 0);

watch([email, password], () => {
  error.value = "";
  showResendConfirm.value = false;
});

watch(
  email,
  (mail) => {
    loadLockoutState(mail);
  },
  { immediate: true },
);

function stopClock() {
  if (!clockTimer) return;
  clearInterval(clockTimer);
  clockTimer = null;
}

function syncClock() {
  stopClock();
  if (!pageVisible.value) return;
  nowMs.value = Date.now();
  clockTimer = setInterval(() => {
    nowMs.value = Date.now();
  }, 1000);
}

onMounted(() => {
  syncClock();
  if (typeof window !== "undefined" && window.localStorage.getItem(NEW_USER_HINT_KEY) !== "1") {
    showNewUserHint.value = true;
  }
  if (route.query.notice === "signup-disabled") {
    ui.pushToast(
      "Student signup removed",
      "Campus events are public at /events. Staff sign in here.",
      "info",
    );
  }
});

watch(
  () => route.query.reason,
  (reason) => {
    if (reason === "inactivity") {
      ui.pushToast(
        "Signed out due to inactivity",
        "You were idle too long, so EventLink signed you out. Sign in again to continue.",
        "warning",
      );
    }
  },
  { immediate: true },
);

onUnmounted(stopClock);

watch(pageVisible, syncClock);

function lockoutKey(mail: string): string {
  return `${LOCKOUT_KEY_PREFIX}${mail.trim().toLowerCase()}`;
}

function loadLockoutState(mail: string) {
  failedPasswordAttempts.value = 0;
  lockedUntilMs.value = 0;
  if (typeof window === "undefined") return;
  const key = lockoutKey(mail);
  const raw = window.localStorage.getItem(key);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { failedAttempts?: number; lockedUntilMs?: number };
    failedPasswordAttempts.value = Math.max(0, Number(parsed.failedAttempts ?? 0));
    lockedUntilMs.value = Math.max(0, Number(parsed.lockedUntilMs ?? 0));
  } catch {
    window.localStorage.removeItem(key);
  }
}

function persistLockoutState(mail: string) {
  if (typeof window === "undefined") return;
  const key = lockoutKey(mail);
  if (failedPasswordAttempts.value <= 0 && lockedUntilMs.value <= 0) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(
    key,
    JSON.stringify({
      failedAttempts: failedPasswordAttempts.value,
      lockedUntilMs: lockedUntilMs.value,
    }),
  );
}

function clearLockoutState(mail: string) {
  failedPasswordAttempts.value = 0;
  lockedUntilMs.value = 0;
  persistLockoutState(mail);
}

function registerFailedPasswordAttempt(mail: string) {
  const nextAttempts = failedPasswordAttempts.value + 1;
  if (nextAttempts >= MAX_FAILED_PASSWORD_ATTEMPTS) {
    failedPasswordAttempts.value = 0;
    lockedUntilMs.value = Date.now() + LOCKOUT_MS;
  } else {
    failedPasswordAttempts.value = nextAttempts;
  }
  persistLockoutState(mail);
}

async function resendConfirmation() {
  if (!email.value.trim()) return;
  resendLoading.value = true;
  try {
    await auth.resendSignupConfirmation(email.value.trim());
    ui.pushToast("Email sent", "Check your inbox for the confirmation link.", "success");
  } catch (e) {
    ui.pushToast("Could not resend", formatAuthError(e), "error");
  } finally {
    resendLoading.value = false;
  }
}

async function completeLogin() {
  const name = auth.displayName ?? "User";
  profile.setFromAuth(name, auth.email ?? email.value.trim(), auth.appRole ?? "");
  notifications.push({
    title: "Signed in",
    body: `Hello, ${name}. Workflow and event alerts will appear here.`,
    category: "system",
  });
  ui.pushToast("Signed in", "Welcome back to EventLink.", "success");
  await router.push(auth.homePath);
}

async function onSubmit() {
  error.value = "";
  if (!email.value.trim() || !password.value) {
    error.value = "Enter your email and password.";
    return;
  }
  if (isPasswordLocked.value) {
    error.value = `Too many wrong attempts. Try again in ${lockRemainingSeconds.value}s.`;
    return;
  }
  loading.value = true;
  try {
    const { assertRateLimitAllowed } = await import("@/services/rateLimitDb");
    await assertRateLimitAllowed("login", email.value.trim().toLowerCase());
    await auth.signIn(email.value.trim(), password.value, { provisional: true });
    clearLockoutState(email.value);
    void auth.activateCurrentSessionSecurity(true);
    await completeLogin();
  } catch (e) {
    const msg = formatAuthError(e);
    const lower = msg.toLowerCase();
    if (lower.includes("invalid email or password") || lower.includes("invalid login credentials")) {
      registerFailedPasswordAttempt(email.value);
      if (isPasswordLocked.value) {
        error.value = `Too many wrong attempts. Try again in ${lockRemainingSeconds.value}s.`;
      } else {
        const left = Math.max(0, MAX_FAILED_PASSWORD_ATTEMPTS - failedPasswordAttempts.value);
        error.value = `${msg} ${left > 0 ? `(${left} attempt${left > 1 ? "s" : ""} left)` : ""}`.trim();
      }
    } else {
      error.value = msg;
    }
    showResendConfirm.value = msg.toLowerCase().includes("not confirmed");
  } finally {
    loading.value = false;
  }
}

function dismissNewUserHint() {
  showNewUserHint.value = false;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(NEW_USER_HINT_KEY, "1");
  }
}
</script>

<template>
  <div class="portal-root flex min-h-dvh flex-col">
    <div
      v-if="showNewUserHint"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div class="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" role="dialog" aria-labelledby="new-user-hint-title">
        <button
          type="button"
          class="absolute right-3 top-3 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
          aria-label="Close"
          @click="dismissNewUserHint"
        >
          <X class="h-4 w-4" />
        </button>
        <h2 id="new-user-hint-title" class="pr-8 text-lg font-semibold text-slate-900">New to EventLink?</h2>
        <p class="mt-2 text-sm text-slate-600">
          If an office just created your account, use <span class="font-semibold">Forgot password</span> with your
          school email. Open the reset link, set your own password, then sign in here. If the email is not in your
          inbox, check Spam or Junk.
        </p>
        <div class="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button type="button" class="portal-btn-secondary text-sm" @click="dismissNewUserHint">Close</button>
          <RouterLink
            to="/forgot-password"
            class="portal-btn inline-flex items-center justify-center text-sm"
            @click="dismissNewUserHint"
          >
            Forgot password
          </RouterLink>
        </div>
      </div>
    </div>
    <div class="flex flex-1 flex-col items-center justify-center px-3 py-10 sm:px-4">
      <div class="mb-6 text-center">
        <div
          class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-lg ring-2 ring-white/30"
        >
          <GraduationCap class="h-7 w-7" />
        </div>
        <h1 class="text-2xl font-bold tracking-tight text-slate-900">EventLink</h1>
        <p class="mt-1 text-sm text-slate-600">University event management portal</p>
      </div>

      <div class="auth-glass-card w-full max-w-md">
        <h2 class="text-lg font-semibold text-slate-900">Sign in</h2>
        <p class="mt-1 text-sm text-slate-600">Use your email and password to continue.</p>

        <form class="mt-6 space-y-4" @submit.prevent="onSubmit">
          <div>
            <label class="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500" for="login-email"
              >Email</label
            >
            <div class="relative">
              <Mail class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                id="login-email"
                v-model="email"
                type="text"
                autocomplete="username"
                class="portal-input pl-10"
                placeholder="name@school.edu"
              />
            </div>
          </div>

          <div>
            <div class="mb-1 flex items-center justify-between gap-2">
              <label class="text-xs font-semibold uppercase tracking-wide text-slate-500" for="login-password"
                >Password</label
              >
              <RouterLink
                to="/forgot-password"
                class="text-xs font-semibold text-emerald-700 hover:text-emerald-800 hover:underline"
              >
                Forgot password?
              </RouterLink>
            </div>
            <div class="relative">
              <Lock class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                id="login-password"
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="current-password"
                class="portal-input pl-10 pr-11"
                placeholder="••••••••"
              />
              <button
                type="button"
                class="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                :aria-label="showPassword ? 'Hide password' : 'Show password'"
                @click="showPassword = !showPassword"
              >
                <EyeOff v-if="showPassword" class="h-4 w-4" />
                <Eye v-else class="h-4 w-4" />
              </button>
            </div>
          </div>

          <p v-if="error" class="text-sm font-medium text-red-700">{{ error }}</p>
          <p v-if="isPasswordLocked" class="text-sm font-medium text-amber-700">
            Login temporarily locked due to repeated incorrect passwords. Wait {{ lockRemainingSeconds }}s before trying
            again.
          </p>

          <button
            v-if="showResendConfirm"
            type="button"
            class="portal-btn-secondary w-full text-sm"
            :disabled="resendLoading"
            @click="resendConfirmation"
          >
            {{ resendLoading ? "Sending…" : "Resend confirmation email" }}
          </button>

          <button type="submit" class="portal-btn w-full" :disabled="loading || isPasswordLocked">
            <ShieldCheck v-if="!loading" class="h-4 w-4" />
            <span v-if="loading">Signing in…</span>
            <span v-else>Continue</span>
          </button>
        </form>

      <p class="mt-8 text-center text-xs text-slate-500">
        <RouterLink to="/events" class="font-medium text-emerald-800 hover:underline">Browse campus events</RouterLink>
        — no sign-in required
      </p>
      </div>
    </div>
  </div>
</template>
