import { computed, ref, watch } from "vue";
import { useAuthStore } from "@/stores/auth";
import {
  analyticsPeriodLabel,
  currentAnalyticsPeriod,
  fetchAnalyticsOverview,
  isAnalyticsPeriodInFuture,
  shiftAnalyticsPeriod,
  type AnalyticsEventRecord,
  type AnalyticsOverview,
  type AnalyticsPeriod,
  type AnalyticsScope,
} from "@/services/analyticsDb";

export type AnalyticsSummaryKind = "org" | "college" | "sdg" | "status";

export type AnalyticsSummaryRow = {
  key: string;
  label: string;
  count: number;
};

export type AnalyticsDrilldown =
  | { view: "summary"; kind: AnalyticsSummaryKind; title: string; rows: AnalyticsSummaryRow[] }
  | { view: "events"; title: string; rows: AnalyticsEventRecord[] };

const TOP_PREVIEW = 6;

function emptyOverview(): AnalyticsOverview {
  return {
    monthlyEvents: [],
    eventStatusData: [
      { name: "Approved", value: 0, color: "#4ADE80" },
      { name: "Pending", value: 0, color: "#D97706" },
      { name: "Rejected", value: 0, color: "#DC2626" },
    ],
    recentActivity: [],
    organizationData: [],
    collegeData: [],
    sdgUsage: [],
    records: [],
    totals: {
      totalThisYear: 0,
      approvedThisMonth: 0,
      approvedLastMonth: 0,
      pendingCount: 0,
      awaitingPublishCount: 0,
      allTimeCount: 0,
    },
    peakMonthLabel: "No data yet",
  };
}

export function useAnalyticsDashboard(scope: AnalyticsScope) {
  const auth = useAuthStore();
  const period = ref<AnalyticsPeriod>(currentAnalyticsPeriod());
  const data = ref<AnalyticsOverview>(emptyOverview());
  const loading = ref(true);
  const error = ref<string | null>(null);
  const drilldown = ref<AnalyticsDrilldown | null>(null);

  const monthLabel = computed(() => analyticsPeriodLabel(period.value));
  const canNextMonth = computed(
    () => !isAnalyticsPeriodInFuture(shiftAnalyticsPeriod(period.value, 1)),
  );

  const topOrganizations = computed(() => data.value.organizationData.slice(0, TOP_PREVIEW));
  const topColleges = computed(() => data.value.collegeData.slice(0, TOP_PREVIEW));
  const topSdgs = computed(() => data.value.sdgUsage.slice(0, TOP_PREVIEW));

  async function load() {
    loading.value = true;
    error.value = null;
    try {
      data.value = await fetchAnalyticsOverview(scope, {
        collegeId: auth.collegeId,
        programId: auth.programId,
        organizationId: auth.organizationId,
        userId: auth.userId,
        period: period.value,
      });
    } catch (e) {
      error.value = e instanceof Error ? e.message : "Could not load analytics.";
      data.value = emptyOverview();
    } finally {
      loading.value = false;
    }
  }

  function setPeriod(next: AnalyticsPeriod) {
    if (isAnalyticsPeriodInFuture(next)) return;
    period.value = next;
  }

  function shiftMonth(delta: number) {
    const next = shiftAnalyticsPeriod(period.value, delta);
    if (delta > 0 && isAnalyticsPeriodInFuture(next)) return;
    period.value = next;
  }

  function openEvents(title: string, rows: AnalyticsEventRecord[]) {
    drilldown.value = { view: "events", title, rows };
  }

  function openOrganizations() {
    drilldown.value = {
      view: "summary",
      kind: "org",
      title: `All organizations · ${monthLabel.value}`,
      rows: data.value.organizationData.map((row) => ({
        key: row.org,
        label: row.org,
        count: row.events,
      })),
    };
  }

  function openColleges() {
    drilldown.value = {
      view: "summary",
      kind: "college",
      title: `All colleges · ${monthLabel.value}`,
      rows: data.value.collegeData.map((row) => ({
        key: row.college,
        label: row.college,
        count: row.events,
      })),
    };
  }

  function openSdgs() {
    drilldown.value = {
      view: "summary",
      kind: "sdg",
      title: `All SDGs · ${monthLabel.value}`,
      rows: data.value.sdgUsage.map((row) => ({
        key: String(row.id),
        label: `SDG ${row.id} · ${row.name}`,
        count: row.value,
      })),
    };
  }

  function openStatus() {
    drilldown.value = {
      view: "summary",
      kind: "status",
      title: `Event status · ${monthLabel.value}`,
      rows: data.value.eventStatusData.map((row) => ({
        key: row.name,
        label: row.name,
        count: row.value,
      })),
    };
  }

  function openAllEvents() {
    openEvents(`All events · ${monthLabel.value}`, data.value.records);
  }

  function selectSummaryRow(row: AnalyticsSummaryRow) {
    const kind = drilldown.value?.view === "summary" ? drilldown.value.kind : null;
    if (!kind) return;
    const records = data.value.records.filter((event) => {
      if (kind === "org") return event.org === row.key;
      if (kind === "college") return event.college === row.key;
      if (kind === "status") return event.status === row.key;
      if (kind === "sdg") return event.sdgIds.includes(Number(row.key));
      return false;
    });
    openEvents(`${row.label} · ${monthLabel.value}`, records);
  }

  watch(
    () => [period.value.year, period.value.month, auth.collegeId, auth.organizationId, auth.userId],
    () => {
      void load();
    },
    { immediate: true },
  );

  return {
    period,
    data,
    loading,
    error,
    monthLabel,
    canNextMonth,
    topOrganizations,
    topColleges,
    topSdgs,
    drilldown,
    setPeriod,
    shiftMonth,
    closeDrilldown: () => {
      drilldown.value = null;
    },
    openOrganizations,
    openColleges,
    openSdgs,
    openStatus,
    openAllEvents,
    selectSummaryRow,
  };
}
