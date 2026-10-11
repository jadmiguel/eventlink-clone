import { defineStore } from "pinia";
import { computed, onScopeDispose, ref } from "vue";
import { getSupabase, isSupabaseConfigured } from "@/lib/supabase";
import { ROLE_HOME_PATH, normalizeLoadedAppRole, PUBLIC_EVENTS_PATH, type AppRole } from "@/types/appRole";
import { useNotificationsStore } from "@/stores/notifications";
import { isDevTestEmailAddress } from "@/config/devAuth";
import { assertRateLimitAllowed } from "@/services/rateLimitDb";
import { enqueueNotification } from "@/services/notificationsDb";
import { toUserFacingError } from "@/utils/userFacingError";

export function formatAuthError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes("email not confirmed")) {
    return "Your email is not confirmed yet. Open the confirmation link Supabase sent you, then sign in again.";
  }
  if (lower.includes("invalid login credentials")) {
    return "Invalid email or password. If you just registered, confirm your email first.";
  }
  return toUserFacingError(err, "Authentication failed. Please try again.");
}

function passwordSetupParams(): {
  type: string | null;
  tokenHash: string | null;
  code: string | null;
  recoveryAccessToken: string | null;
} {
  if (typeof window === "undefined") {
    return { type: null, tokenHash: null, code: null, recoveryAccessToken: null };
  }
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const type = query.get("type") || hash.get("type");
  return {
    type,
    tokenHash: query.get("token_hash") || hash.get("token_hash"),
    code: query.get("code") || hash.get("code"),
    recoveryAccessToken: hash.get("type") === "recovery" || hash.get("type") === "invite" ? hash.get("access_token") : null,
  };
}

function isPasswordSetupLocation(): boolean {
  if (typeof window === "undefined") return false;
  const path = window.location.pathname.replace(/\/$/, "") || "/";
  if (path === "/reset-password") return true;
  const { type } = passwordSetupParams();
  return type === "recovery" || type === "invite" || type === "signup" || type === "magiclink";
}

export const useAuthStore = defineStore("auth", () => {
  const DEFAULT_INACTIVITY_LOGOUT_MS = 10 * 60 * 1000;
  const EXTENDED_INACTIVITY_LOGOUT_MS = 5 * 60 * 60 * 1000;
  const SINGLE_SESSION_CHECK_MS = 15 * 1000;
  const IDLE_CHECK_MS = 15 * 1000;
  const INACTIVITY_WARNING_MS = 60 * 1000;
  const ACTIVITY_PERSIST_THROTTLE_MS = 1000;
  const LAST_ACTIVITY_STORAGE_KEY = "eventlink_last_activity";
  const ACTIVITY_BROADCAST_NAME = "eventlink-activity";
  const ACTIVITY_EVENTS = ["pointerdown", "keydown", "scroll"] as const;
  const ACTIVITY_LISTENER_OPTIONS = { passive: true } as const;
  const EXTENDED_SESSION_ROLES = new Set<AppRole>(["eo", "gso", "osas"]);

  const ready = ref(false);
  const userId = ref<string | null>(null);
  const email = ref<string | null>(null);
  const displayName = ref<string | null>(null);
  const appRole = ref<AppRole | null>(null);
  const collegeId = ref<string | null>(null);
  const programId = ref<string | null>(null);
  const organizationId = ref<string | null>(null);
  const passwordRecoveryPending = ref(false);
  const useMock = computed(() => import.meta.env.DEV && !isSupabaseConfigured);
  const stayOnlineEnabled = ref(false);

  const isAuthenticated = computed(() => !!email.value && (useMock.value || !!userId.value));
  const canUseExtendedSession = computed(
    () => !!appRole.value && EXTENDED_SESSION_ROLES.has(appRole.value),
  );
  const inactivityLogoutMs = computed(() =>
    canUseExtendedSession.value && stayOnlineEnabled.value
      ? EXTENDED_INACTIVITY_LOGOUT_MS
      : DEFAULT_INACTIVITY_LOGOUT_MS,
  );

  const homePath = computed(() => {
    if (appRole.value) return ROLE_HOME_PATH[appRole.value] ?? "/login";
    return PUBLIC_EVENTS_PATH;
  });

  let readyResolve: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  let idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  let warningTicker: ReturnType<typeof setInterval> | null = null;
  let singleSessionTimer: ReturnType<typeof setInterval> | null = null;
  let inactivityListenersBound = false;
  let currentSessionMarker: string | null = null;
  let sessionClaimEpoch = 0;
  let applySessionTail: Promise<void> = Promise.resolve();
  let singleSessionVerificationPromise: Promise<void> | null = null;
  const lastActivityAt = ref(0);
  const inactivityWarning = ref(false);
  const inactivityWarningSeconds = ref(0);
  let lastActivityPersistAt = 0;
  let activityChannel: BroadcastChannel | null = null;
  let inactivitySignOutInFlight = false;

  function sessionPreferenceKey() {
    if (!userId.value || !appRole.value) return null;
    return `eventlink:stay-online:${userId.value}:${appRole.value}`;
  }

  function loadSessionPreference() {
    if (typeof window === "undefined") return;
    if (!canUseExtendedSession.value) {
      stayOnlineEnabled.value = false;
      return;
    }
    const key = sessionPreferenceKey();
    if (!key) {
      stayOnlineEnabled.value = false;
      return;
    }
    stayOnlineEnabled.value = window.localStorage.getItem(key) === "1";
  }

  function persistSessionPreference() {
    if (typeof window === "undefined") return;
    const key = sessionPreferenceKey();
    if (!key) return;
    if (!canUseExtendedSession.value) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, stayOnlineEnabled.value ? "1" : "0");
  }

  function clearIdleCheckTimer() {
    if (idleCheckTimer) {
      clearInterval(idleCheckTimer);
      idleCheckTimer = null;
    }
    if (warningTicker) {
      clearInterval(warningTicker);
      warningTicker = null;
    }
  }

  function clearSingleSessionTimer() {
    if (singleSessionTimer) {
      clearInterval(singleSessionTimer);
      singleSessionTimer = null;
    }
  }

  function pauseSingleSessionPolling() {
    clearSingleSessionTimer();
  }

  function isDocumentVisible() {
    return (
      typeof document === "undefined" ||
      (document.visibilityState !== "hidden" && !document.hidden)
    );
  }

  function readStoredLastActivityAt(): number {
    if (typeof window === "undefined") return 0;
    const raw = Number(window.localStorage.getItem(LAST_ACTIVITY_STORAGE_KEY) ?? "0");
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  function loadLastActivityAt() {
    lastActivityAt.value = readStoredLastActivityAt();
  }

  function persistLastActivityAt(ts: number) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(ts));
    if (activityChannel) {
      try {
        activityChannel.postMessage({ at: ts });
      } catch {
        // BroadcastChannel may be unavailable in some privacy modes.
      }
    }
  }

  function clearLastActivityAt() {
    lastActivityAt.value = 0;
    inactivityWarning.value = false;
    inactivityWarningSeconds.value = 0;
    lastActivityPersistAt = 0;
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(LAST_ACTIVITY_STORAGE_KEY);
  }

  function touchActivity() {
    const now = Date.now();
    lastActivityAt.value = now;
    inactivityWarning.value = false;
    inactivityWarningSeconds.value = 0;
    if (warningTicker) {
      clearInterval(warningTicker);
      warningTicker = null;
    }
    if (now - lastActivityPersistAt >= ACTIVITY_PERSIST_THROTTLE_MS) {
      lastActivityPersistAt = now;
      persistLastActivityAt(now);
    }
  }

  function goToInactivityLogin() {
    void import("@/router").then(({ default: router }) => {
      const current = router.currentRoute.value;
      if (current.name === "login" && current.query.reason === "inactivity") return;
      void router.replace({ name: "login", query: { reason: "inactivity" } });
    });
  }

  /** Local wall-clock idle check. No network. */
  function evaluateIdleTimeout() {
    if (!isAuthenticated.value || inactivitySignOutInFlight) {
      inactivityWarning.value = false;
      inactivityWarningSeconds.value = 0;
      return;
    }

    const stored = readStoredLastActivityAt();
    if (stored > lastActivityAt.value) lastActivityAt.value = stored;
    if (!lastActivityAt.value) {
      touchActivity();
      persistLastActivityAt(lastActivityAt.value);
      return;
    }

    const elapsed = Date.now() - lastActivityAt.value;
    const remaining = inactivityLogoutMs.value - elapsed;
    if (remaining <= 0) {
      void signOutDueToInactivity();
      return;
    }

    const warn = remaining <= INACTIVITY_WARNING_MS;
    inactivityWarning.value = warn;
    inactivityWarningSeconds.value = warn ? Math.max(1, Math.ceil(remaining / 1000)) : 0;
    if (warn && !warningTicker) {
      warningTicker = setInterval(() => {
        evaluateIdleTimeout();
      }, 1000);
    } else if (!warn && warningTicker) {
      clearInterval(warningTicker);
      warningTicker = null;
    }
  }

  function onTabBecameVisible() {
    evaluateIdleTimeout();
    if (currentSessionMarker) startSingleSessionPolling();
  }

  function isSecurityExemptEmail(mail: string | null | undefined): boolean {
    return isDevTestEmailAddress(mail ?? "");
  }

  function sessionMarkerKey() {
    if (!userId.value) return null;
    return `eventlink:session-marker:${userId.value}`;
  }

  function generateSessionMarker(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  async function fetchLoginMeta() {
    const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "Unknown device";
    let ip = "unknown";
    let location = "unknown";
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 800);
      const res = await fetch("https://ipapi.co/json/", { signal: ctl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const json = (await res.json()) as {
          ip?: string;
          city?: string;
          region?: string;
          country_name?: string;
        };
        ip = json.ip ?? ip;
        const parts = [json.city, json.region, json.country_name].filter(Boolean);
        if (parts.length) location = parts.join(", ");
      }
    } catch {
      // best effort only
    }
    return { userAgent, ip, location };
  }

  async function writeActiveSession(marker: string, showLoginAlert: boolean, epoch: number) {
    if (!userId.value) return;
    const uid = userId.value;
    const supabase = getSupabase();
    const loginMeta = showLoginAlert
      ? await fetchLoginMeta()
      : {
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "Unknown device",
          ip: "unknown",
          location: "unknown",
        };
    if (epoch !== sessionClaimEpoch || userId.value !== uid) return;
    const metadata = {
      browser: loginMeta.userAgent,
      ip: loginMeta.ip,
      location: loginMeta.location,
      logged_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from("profiles")
      .update({
        active_session_id: marker,
        active_session_updated_at: new Date().toISOString(),
        last_login_metadata: metadata,
      })
      .eq("id", uid);
    if (error) throw error;
    if (epoch !== sessionClaimEpoch || userId.value !== uid) return;

    if (typeof window !== "undefined") {
      const key = `eventlink:session-marker:${uid}`;
      window.localStorage.setItem(key, marker);
    }

    let notificationCreated = false;
    if (showLoginAlert) {
      try {
        await enqueueNotification({
          userId: userId.value,
          eventType: "login_detected",
          dedupKey: `security-login:${marker}`,
          context: {
            device: metadata.browser,
            ip: metadata.ip,
            location: metadata.location,
            time: new Date(metadata.logged_at).toLocaleString(),
          },
        });
        notificationCreated = true;
      } catch {
        // Session tracking remains authoritative if notification enqueue is unavailable.
      }
    }
    if (notificationCreated && showLoginAlert) {
      try {
        useNotificationsStore().push({
          title: "New login detected",
          body:
            `Device: ${metadata.browser}\n` +
            `IP: ${metadata.ip}\n` +
            `Location: ${metadata.location}\n` +
            `Time: ${new Date(metadata.logged_at).toLocaleString()}`,
          category: "security",
          href: "/forgot-password",
        });
      } catch {
        // store may not be ready yet
      }
    }
  }

  function verifySingleSessionStillActive(): Promise<void> {
    if (singleSessionVerificationPromise) return singleSessionVerificationPromise;

    singleSessionVerificationPromise = (async () => {
      const uid = userId.value;
      const marker = currentSessionMarker;
      const epoch = sessionClaimEpoch;
      if (!uid || !marker) return;
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from("profiles")
        .select("active_session_id")
        .eq("id", uid)
        .maybeSingle();
      if (error) return;
      if (userId.value !== uid || currentSessionMarker !== marker || epoch !== sessionClaimEpoch) {
        return;
      }
      const active = (data?.active_session_id as string | null) ?? null;
      if (active && active !== marker) {
        await signOut();
        if (typeof window !== "undefined") {
          window.alert(
            "Your account was signed in from another device, so this session was ended for security.",
          );
        }
      }
    })().finally(() => {
      singleSessionVerificationPromise = null;
    });

    return singleSessionVerificationPromise;
  }

  function startSingleSessionPolling() {
    if (
      singleSessionTimer ||
      !isDocumentVisible() ||
      useMock.value ||
      !userId.value ||
      !currentSessionMarker ||
      isSecurityExemptEmail(email.value)
    ) {
      return;
    }
    singleSessionTimer = setInterval(() => {
      if (!isDocumentVisible()) {
        pauseSingleSessionPolling();
        return;
      }
      void verifySingleSessionStillActive();
    }, SINGLE_SESSION_CHECK_MS);
  }

  async function activateCurrentSessionSecurity(showLoginAlert: boolean) {
    if (useMock.value || !userId.value || isSecurityExemptEmail(email.value)) return;
    pauseSingleSessionPolling();
    const uid = userId.value;
    const epoch = ++sessionClaimEpoch;
    const marker = generateSessionMarker();
    currentSessionMarker = marker;
    await writeActiveSession(marker, showLoginAlert, epoch);
    if (epoch !== sessionClaimEpoch || userId.value !== uid) return;
    await verifySingleSessionStillActive();
    if (epoch !== sessionClaimEpoch || userId.value !== uid) return;
    startSingleSessionPolling();
  }

  function resumeSingleSessionMonitorFromStorage() {
    if (useMock.value || !userId.value || isSecurityExemptEmail(email.value)) return;
    if (singleSessionTimer && currentSessionMarker) return;
    if (typeof window !== "undefined") {
      const key = sessionMarkerKey();
      const stored = key ? window.localStorage.getItem(key) : null;
      if (stored) currentSessionMarker = stored;
    }
    if (!currentSessionMarker) {
      void activateCurrentSessionSecurity(false);
      return;
    }
    startSingleSessionPolling();
  }

  function signOutDueToInactivity() {
    if (!isAuthenticated.value || inactivitySignOutInFlight) return;
    inactivitySignOutInFlight = true;
    inactivityWarning.value = false;
    inactivityWarningSeconds.value = 0;
    void signOut({ reason: "inactivity" });
  }

  function onStorageActivity(event: StorageEvent) {
    if (event.key !== LAST_ACTIVITY_STORAGE_KEY || event.newValue == null) return;
    const next = Number(event.newValue);
    if (!Number.isFinite(next) || next <= 0) return;
    lastActivityAt.value = next;
    evaluateIdleTimeout();
  }

  function onBroadcastActivity(event: MessageEvent<{ at?: number }>) {
    const next = Number(event.data?.at ?? 0);
    if (!Number.isFinite(next) || next <= 0) return;
    if (next > lastActivityAt.value) lastActivityAt.value = next;
    evaluateIdleTimeout();
  }

  function onActivity() {
    if (!isAuthenticated.value) return;
    touchActivity();
  }

  function bindInactivityListeners() {
    if (typeof window === "undefined" || inactivityListenersBound) return;
    ACTIVITY_EVENTS.forEach((eventName) => {
      window.addEventListener(eventName, onActivity, ACTIVITY_LISTENER_OPTIONS);
    });
    window.addEventListener("storage", onStorageActivity);
    try {
      activityChannel = new BroadcastChannel(ACTIVITY_BROADCAST_NAME);
      activityChannel.addEventListener("message", onBroadcastActivity);
    } catch {
      activityChannel = null;
    }
    inactivityListenersBound = true;
  }

  function unbindInactivityListeners() {
    if (typeof window === "undefined" || !inactivityListenersBound) return;
    ACTIVITY_EVENTS.forEach((eventName) => {
      window.removeEventListener(eventName, onActivity);
    });
    window.removeEventListener("storage", onStorageActivity);
    if (activityChannel) {
      activityChannel.removeEventListener("message", onBroadcastActivity);
      activityChannel.close();
      activityChannel = null;
    }
    inactivityListenersBound = false;
  }

  onScopeDispose(() => {
    unbindInactivityListeners();
    clearIdleCheckTimer();
    pauseSingleSessionPolling();
  });

  function startInactivityMonitor() {
    bindInactivityListeners();
    if (!lastActivityAt.value) loadLastActivityAt();
    if (!lastActivityAt.value) {
      touchActivity();
      persistLastActivityAt(lastActivityAt.value);
    }
    if (!idleCheckTimer) {
      idleCheckTimer = setInterval(() => {
        evaluateIdleTimeout();
      }, IDLE_CHECK_MS);
    }
    evaluateIdleTimeout();
  }

  function markReady() {
    if (!ready.value) {
      ready.value = true;
      readyResolve?.();
    }
  }

  async function whenReady() {
    if (ready.value) return;
    await readyPromise;
  }

  async function loadRole(uid: string) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", uid)
      .maybeSingle();

    if (error) throw error;
    appRole.value = normalizeLoadedAppRole(data?.role as string | undefined);
  }

  async function repairProfileIfMissing() {
    const supabase = getSupabase();
    const { error } = await supabase.rpc("ensure_my_profile");
    if (error) {
      console.warn("ensure_my_profile:", error.message);
    }
  }

  async function loadProfile(uid: string) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("profiles")
      .select("display_name, email, college_id, program_id, organization_id")
      .eq("id", uid)
      .maybeSingle();

    if (error) throw error;
    displayName.value = data?.display_name ?? displayName.value;
    if (data?.email) email.value = data.email;
    collegeId.value = (data?.college_id as string | null | undefined) ?? null;
    programId.value = (data?.program_id as string | null | undefined) ?? null;
    organizationId.value = (data?.organization_id as string | null | undefined) ?? null;
  }

  async function applySession(
    session: { user: { id: string; email?: string | null } } | null,
    opts?: {
      enforceSingleSession?: boolean;
      showLoginAlert?: boolean;
      resetIdleClock?: boolean;
      provisional?: boolean;
    },
  ) {
    const run = applySessionTail.then(
      () => applySessionUnlocked(session, opts),
      () => applySessionUnlocked(session, opts),
    );
    applySessionTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function applySessionUnlocked(
    session: { user: { id: string; email?: string | null } } | null,
    opts?: {
      enforceSingleSession?: boolean;
      showLoginAlert?: boolean;
      resetIdleClock?: boolean;
      provisional?: boolean;
    },
  ) {
    const enforceSingleSession = opts?.enforceSingleSession ?? true;
    const showLoginAlert = opts?.showLoginAlert ?? false;
    if (!session?.user) {
      clearIdleCheckTimer();
      clearSingleSessionTimer();
      currentSessionMarker = null;
      inactivitySignOutInFlight = false;
      stayOnlineEnabled.value = false;
      userId.value = null;
      email.value = null;
      displayName.value = null;
      appRole.value = null;
      collegeId.value = null;
      programId.value = null;
      organizationId.value = null;
      try {
        useNotificationsStore().clear();
      } catch {
        // ignore store lifecycle timing issues
      }
      return;
    }
    if (userId.value === session.user.id && appRole.value) {
      if (session.user.email) email.value = session.user.email;
      return;
    }
    userId.value = session.user.id;
    email.value = session.user.email ?? null;
    await Promise.all([loadRole(session.user.id), loadProfile(session.user.id)]);
    if (!appRole.value) {
      await repairProfileIfMissing();
      await Promise.all([loadRole(session.user.id), loadProfile(session.user.id)]);
    } else {
      void repairProfileIfMissing();
    }
    try {
      void useNotificationsStore().hydrate(false);
    } catch {
      // best effort: login should not fail due to notification hydration
    }
    loadSessionPreference();
    inactivitySignOutInFlight = false;
    if (opts?.resetIdleClock) {
      touchActivity();
      persistLastActivityAt(lastActivityAt.value);
    } else {
      loadLastActivityAt();
    }
    startInactivityMonitor();
    if (isSecurityExemptEmail(session.user.email ?? email.value)) {
      clearSingleSessionTimer();
      currentSessionMarker = null;
    } else if (opts?.provisional) {
      pauseSingleSessionPolling();
      currentSessionMarker = null;
    } else if (enforceSingleSession) {
      void activateCurrentSessionSecurity(showLoginAlert);
    } else {
      resumeSingleSessionMonitorFromStorage();
    }
  }

  function setStayOnlineEnabled(enabled: boolean) {
    if (!canUseExtendedSession.value) {
      stayOnlineEnabled.value = false;
      return;
    }
    stayOnlineEnabled.value = enabled;
    persistSessionPreference();
    evaluateIdleTimeout();
  }

  let lastSessionRefreshAt = 0;

  async function init() {
    bindInactivityListeners();
    if (useMock.value) {
      markReady();
      return;
    }
    if (!isSupabaseConfigured) {
      // Production must remain unauthenticated when the backend is unavailable.
      markReady();
      return;
    }

    const supabase = getSupabase();
    try {
      const setup = passwordSetupParams();
      if (setup.tokenHash && setup.type) {
        const { data: otpData } = await supabase.auth.verifyOtp({
          token_hash: setup.tokenHash,
          type: setup.type as "recovery" | "invite" | "signup" | "magiclink" | "email",
        });
        if (otpData.session) passwordRecoveryPending.value = true;
      }

      const { data } = await supabase.auth.getSession();
      if (isPasswordSetupLocation() && data.session) {
        passwordRecoveryPending.value = true;
      } else if (setup.recoveryAccessToken && data.session?.access_token === setup.recoveryAccessToken) {
        passwordRecoveryPending.value = true;
      }
      await applySession(data.session, { enforceSingleSession: false, showLoginAlert: false });

      supabase.auth.onAuthStateChange(async (event, session) => {
        if (
          event === "PASSWORD_RECOVERY" ||
          (event === "SIGNED_IN" && isPasswordSetupLocation() && session)
        ) {
          passwordRecoveryPending.value = !!session;
          if (event === "PASSWORD_RECOVERY" || isPasswordSetupLocation()) return;
        }
        if (event === "SIGNED_OUT") {
          passwordRecoveryPending.value = false;
          await applySession(null);
          return;
        }
        // Tab focus / autoRefreshToken emit these. Re-hydrating here
        // clears auth fields and the router tears down <RouterView>.
        if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
          lastSessionRefreshAt = Date.now();
          return;
        }
        if (event === "INITIAL_SESSION") {
          if (userId.value || !session?.user) return;
          await applySession(session, { enforceSingleSession: false, showLoginAlert: false });
          return;
        }
        if (event === "SIGNED_IN") {
          if (session?.user && userId.value === session.user.id && appRole.value) {
            lastSessionRefreshAt = Date.now();
            return;
          }
          await applySession(session, {
            enforceSingleSession: true,
            showLoginAlert: false,
            resetIdleClock: true,
          });
        }
      });
    } finally {
      markReady();
    }
  }

  async function verifyStudentRegistry(studentId: string): Promise<boolean> {
    if (useMock.value) {
      const { useStudentRegistryStore } = await import("@/stores/studentRegistry");
      return !!useStudentRegistryStore().lookup(studentId);
    }
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc("verify_student_registry", {
      p_student_id: studentId,
    });
    if (error) throw error;
    return !!data;
  }

  async function fetchRegistryRow(studentId: string): Promise<{
    studentId: string;
    fullName: string;
    email?: string;
    college?: string;
    program?: string;
  } | null> {
    if (useMock.value) {
      const { useStudentRegistryStore } = await import("@/stores/studentRegistry");
      const row = useStudentRegistryStore().lookup(studentId);
      if (!row) return null;
      return {
        studentId: row.studentId,
        fullName: row.fullName,
        email: row.email,
        college: row.course,
        program: row.program,
      };
    }
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc("get_student_registry_row", {
      p_student_id: studentId,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return {
      studentId: row.student_id as string,
      fullName: row.full_name as string,
      email: (row.email as string | null) ?? undefined,
      college: (row.college as string | null) ?? undefined,
      program: (row.program as string | null) ?? undefined,
    };
  }

  async function signIn(mail: string, password: string, opts?: { provisional?: boolean }) {
    if (useMock.value) {
      loginMock(mail, mail.includes("admin") ? "Admin User" : "Portal User", mail.includes("admin") ? "admin" : "adviser");
      return { mock: true as const };
    }

    const supabase = getSupabase();
    const { data, error } = await supabase.auth.signInWithPassword({
      email: mail.trim(),
      password,
    });
    if (error) throw new Error(formatAuthError(error));
    await applySession(data.session, {
      enforceSingleSession: !opts?.provisional,
      showLoginAlert: !opts?.provisional,
      resetIdleClock: true,
      provisional: opts?.provisional === true,
    });
    return { mock: false as const };
  }

  async function resendSignupConfirmation(mail: string) {
    if (useMock.value) return;

    const supabase = getSupabase();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email: mail.trim(),
    });
    if (error) throw new Error(formatAuthError(error));
  }

  async function sendEmailOtp(mail: string) {
    if (useMock.value) return;
    const supabase = getSupabase();
    const { error } = await supabase.auth.signInWithOtp({
      email: mail.trim(),
      options: {
        shouldCreateUser: false,
      },
    });
    if (error) throw new Error(formatAuthError(error));
  }

  async function verifyEmailOtp(mail: string, token: string) {
    if (useMock.value) return;
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.verifyOtp({
      email: mail.trim(),
      token: token.trim(),
      type: "email",
    });
    if (error) throw new Error(formatAuthError(error));
    await applySession(data.session ?? null, {
      enforceSingleSession: true,
      showLoginAlert: true,
      resetIdleClock: true,
    });
  }

  async function signUp(opts: {
    email: string;
    password: string;
    studentId: string;
    fullName: string;
  }): Promise<{ needsEmailConfirmation: boolean }> {
    if (useMock.value) {
      loginMock(opts.email, opts.fullName, "adviser");
      return { needsEmailConfirmation: false };
    }

    const supabase = getSupabase();
    const { data, error } = await supabase.auth.signUp({
      email: opts.email.trim(),
      password: opts.password,
      options: {
        data: {
          student_id: opts.studentId,
          full_name: opts.fullName,
        },
      },
    });
    if (error) throw new Error(formatAuthError(error));

    if (data.session) {
      await applySession(data.session, { resetIdleClock: true });
      return { needsEmailConfirmation: false };
    }

    // Supabase "Confirm email" is on — account exists but there is no session yet.
    await applySession(null);
    return { needsEmailConfirmation: true };
  }

  async function resetPassword(mail: string) {
    if (useMock.value) {
      throw new Error("Password recovery is unavailable in local mock mode.");
    }

    const supabase = getSupabase();
    await assertRateLimitAllowed("password_reset", mail.trim().toLowerCase());
    const redirectTo = `${window.location.origin}/reset-password`;
    const { error } = await supabase.auth.resetPasswordForEmail(mail.trim(), { redirectTo });
    if (error) throw new Error(formatAuthError(error));
  }

  async function updatePassword(password: string) {
    if (useMock.value) {
      throw new Error("Password recovery is unavailable in local mock mode.");
    }
    const supabase = getSupabase();
    if (!passwordRecoveryPending.value) {
      const { data } = await supabase.auth.getSession();
      if (!data.session || !isPasswordSetupLocation()) {
        throw new Error("This password reset link is invalid or has expired.");
      }
      passwordRecoveryPending.value = true;
    }
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session) {
      throw new Error("This password reset link is invalid or has expired.");
    }
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw new Error(formatAuthError(error));
    passwordRecoveryPending.value = false;
  }

  async function signOut(opts?: { reason?: "inactivity"; scope?: "local" | "global" | "others" }) {
    sessionClaimEpoch += 1;
    clearIdleCheckTimer();
    clearSingleSessionTimer();
    currentSessionMarker = null;
    if (useMock.value) {
      logout();
      if (opts?.reason === "inactivity") goToInactivityLogin();
      return;
    }
    const supabase = getSupabase();
    logout();
    if (opts?.reason === "inactivity") goToInactivityLogin();
    try {
      await Promise.race([
        supabase.auth.signOut({ scope: opts?.scope ?? "local" }),
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, 4000);
        }),
      ]);
    } catch {
      try {
        await supabase.auth.signOut({ scope: "local" });
      } catch {
        // Local UI already cleared.
      }
    }
  }

  /** Local-only fallback when Supabase env vars are missing. */
  function loginMock(e: string, name: string, r: string) {
    if (!import.meta.env.DEV) {
      throw new Error("Mock authentication is disabled.");
    }
    email.value = e;
    displayName.value = name;
    const roleMap: Record<string, AppRole> = {
      admin: "admin",
      "student-officer": "student_officer",
      officer: "student_officer",
      student_officer: "student_officer",
      ssc: "ssc",
      adviser: "adviser",
      dean: "dean",
      osas: "osas",
      eo: "eo",
      gso: "gso",
      it_infrastructure: "it_infrastructure",
      "it-infrastructure": "it_infrastructure",
      sports_office: "sports_office",
      "sports-office": "sports_office",
      infirmary: "infirmary",
      nstp: "nstp",
    };
    appRole.value = roleMap[r] ?? null;
    userId.value = "mock-user";
    loadSessionPreference();
    touchActivity();
    persistLastActivityAt(lastActivityAt.value);
    startInactivityMonitor();
  }

  function logout() {
    clearIdleCheckTimer();
    clearSingleSessionTimer();
    currentSessionMarker = null;
    clearLastActivityAt();
    stayOnlineEnabled.value = false;
    email.value = null;
    displayName.value = null;
    appRole.value = null;
    collegeId.value = null;
    programId.value = null;
    organizationId.value = null;
    userId.value = null;
    passwordRecoveryPending.value = false;
  }

  return {
    ready,
    useMock,
    isSupabaseConfigured: isSupabaseConfigured,
    userId,
    email,
    displayName,
    appRole,
    collegeId,
    programId,
    organizationId,
    passwordRecoveryPending,
    stayOnlineEnabled,
    canUseExtendedSession,
    inactivityLogoutMs,
    inactivityWarning,
    inactivityWarningSeconds,
    role: computed(() => appRole.value),
    isAuthenticated,
    homePath,
    whenReady,
    init,
    pauseSingleSessionPolling,
    onTabBecameVisible,
    verifyStudentRegistry,
    fetchRegistryRow,
    signIn,
    signUp,
    resendSignupConfirmation,
    sendEmailOtp,
    verifyEmailOtp,
    activateCurrentSessionSecurity,
    resetPassword,
    updatePassword,
    signOut,
    setStayOnlineEnabled,
    loginMock,
    logout,
  };
});
