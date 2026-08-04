import { Component, useCallback, useEffect, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import {
  EvaluationCommandSchema,
  EvaluationRunSpecSchema,
  EvaluationRunTemplateSchema,
  formatEvaluatedSliceLabel,
  leaderboardComparabilityKey,
} from "@agent-kernel/eval-protocol";
import type {
  ControlPlaneCapabilities,
  EvaluationCommand,
  EvaluationQuery,
  EvaluationRunSpec,
  EvaluationRunTemplate,
  LeaderboardEntry,
} from "@agent-kernel/eval-protocol";
import { DashboardControlPlane, errorMessage, type Page } from "./client.js";
import {
  initialLocale,
  SUPPORTED_LOCALES,
  translate,
  type Locale,
  type MessageKey,
} from "./i18n/index.js";
import {
  loadOperatorCommand,
  operatorCommandEnvelope,
  operatorSession,
  saveOperatorCommand,
  type StoredOperatorCommand,
} from "./operator-session.js";
import { ROUTES, routeFromPath, type RouteId } from "./routes.js";
import { Administration } from "./components/administration.js";
import { EmptyScene, Metric, PanelHeading, Rows } from "./components/data-table.js";

type LoadState =
  | "loading"
  | "ready"
  | "empty"
  | "partial"
  | "stale"
  | "error"
  | "offline"
  | "unsupported";
type Resource = {
  title: string;
  query: EvaluationQuery;
  capability: string;
  columns: string[];
  filters?: Array<{ parameter: string; label: string; values?: string[] }>;
};

const RESOURCES: Record<
  Exclude<RouteId, "overview" | "library" | "leaderboard" | "administration">,
  Resource
> = {
  runs: {
    title: "Evaluation runs",
    query: { resource: "runs", page: { limit: 100 } },
    capability: "runs",
    columns: [
      "accepted.spec.runId",
      "accepted.spec.taskPack.id",
      "state",
      "trialIds",
      "resourceUsage.costUsd",
      "updatedAt",
    ],
  },
  analysis: {
    title: "Analysis jobs",
    query: { resource: "analysis-jobs", page: { limit: 100 } },
    capability: "analysis-jobs",
    columns: ["jobId", "runId", "kind", "state"],
    filters: [
      { parameter: "state", label: "State" },
      {
        parameter: "kind",
        label: "Job kind",
        values: [
          "grading",
          "detectors",
          "trace-alignment",
          "clustering",
          "counterfactual",
          "minimization",
          "report",
          "regression-gate",
        ],
      },
    ],
  },
  defects: {
    title: "Verified defects",
    query: { resource: "defects", page: { limit: 100 } },
    capability: "defects",
    columns: [
      "findingId",
      "runId",
      "trialId",
      "category",
      "severity",
      "status",
    ],
    filters: [
      {
        parameter: "category",
        label: "Category",
        values: [
          "instruction_drift",
          "context_forgetting",
          "test_gaming",
          "tool_recovery",
          "planning_execution",
          "trace_divergence",
          "unknown",
        ],
      },
      {
        parameter: "status",
        label: "Status",
        values: ["detected", "human_validated", "rejected", "promoted"],
      },
      { parameter: "runId", label: "Run" },
    ],
  },
  regression: {
    title: "Regression packs",
    query: { resource: "regressions", page: { limit: 100 } },
    capability: "regressions",
    columns: ["pack", "version", "owner"],
  },
  insights: {
    title: "Product insights",
    query: { resource: "insights", page: { limit: 100 } },
    capability: "insights",
    columns: ["insight", "severity", "status"],
  },
  reports: {
    title: "Evidence reports",
    query: { resource: "reports", page: { limit: 100 } },
    capability: "reports",
    columns: [
      "reportId",
      "runRefs",
      "methodologyVersion",
      "redactionPassed",
      "generatedAt",
    ],
    filters: [{ parameter: "runId", label: "Run" }],
  },
};

const DEFAULT_CONTROL_PLANE = new DashboardControlPlane();

export class DashboardErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: true } {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    /* Avoid rendering or persisting sensitive error detail. */
  }
  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="fatal-recovery" role="alert">
        <section className="panel">
          <p>Non-destructive recovery</p>
          <h1>The evaluation view could not be rendered</h1>
          <p>
            Durable Control Plane state was not changed. Reload the UI to query
            the authoritative projection again.
          </p>
          <button
            className="primary"
            onClick={() => globalThis.location.reload()}
          >
            Reload authoritative UI
          </button>
        </section>
      </main>
    );
  }
}

export function App({
  controlPlane = DEFAULT_CONTROL_PLANE,
}: {
  controlPlane?: DashboardControlPlane;
}): JSX.Element {
  const [route, setRoute] = useState(() =>
    routeFromPath(globalThis.location.pathname),
  );
  const [locale, setLocale] = useState<Locale>(() => initialLocale());
  const [capabilities, setCapabilities] = useState<ControlPlaneCapabilities>();
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState(
    "Connecting to the local Control Plane…",
  );
  const [data, setData] = useState<unknown>();
  const [lastUpdated, setLastUpdated] = useState<string>();
  const [liveState, setLiveState] = useState<
    "idle" | "connected" | "reconnecting"
  >("idle");
  const hasAuthoritativeData = useRef(false);
  const authoritativeRoute = useRef<RouteId>();
  const liveSequences = useRef(new Map<string, number>());
  const liveRefreshPending = useRef(false);
  const liveRefreshAgain = useRef(false);

  const navigate = useCallback((path: string) => {
    globalThis.history.pushState({}, "", path);
    setRoute(routeFromPath(path));
  }, []);

  useEffect(() => {
    const pop = () => setRoute(routeFromPath(globalThis.location.pathname));
    globalThis.addEventListener("popstate", pop);
    return () => globalThis.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    localStorage.setItem("agent-eval-locale", locale);
  }, [locale]);

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const requestedRoute = route.id;
      if (authoritativeRoute.current !== requestedRoute) {
        setData(undefined);
        hasAuthoritativeData.current = false;
      }
      setState(navigator.onLine ? "loading" : "offline");
      try {
        const currentCapabilities = await controlPlane.connect(signal);
        signal?.throwIfAborted();
        setCapabilities(currentCapabilities);
        const loaded = await loadRoute(
          controlPlane,
          route.id,
          currentCapabilities,
          signal ?? new AbortController().signal,
        );
        signal?.throwIfAborted();
        setData(loaded);
        hasAuthoritativeData.current = true;
        authoritativeRoute.current = requestedRoute;
        const loadedState = classifyLoadedState(loaded);
        setState(loadedState);
        setMessage(
          loadedState === "partial"
            ? "Showing the first authoritative page. More records are available."
            : "Authoritative state is current.",
        );
        setLastUpdated(new Date().toISOString());
      } catch (error) {
        if (signal?.aborted) return;
        const text = errorMessage(error);
        const unsupported =
          /unsupported(?:\s+control\s+plane)?\s+protocol/iu.test(text);
        const stale =
          !unsupported &&
          hasAuthoritativeData.current &&
          authoritativeRoute.current === requestedRoute;
        setMessage(
          stale
            ? "The last authoritative projection is retained, but refresh failed: " +
                text
            : text,
        );
        setState(
          unsupported
            ? "unsupported"
            : stale
              ? "stale"
              : navigator.onLine
                ? "error"
                : "offline",
        );
      }
    },
    [controlPlane, route.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  const liveRuns = liveRunsFrom(route.id, data);
  const liveRunsKey = liveRuns
    .map((run) => run.runId + ":" + String(run.sequence))
    .join("|");
  const projectedSequence = liveRuns[0]?.sequence ?? -1;
  useEffect(() => {
    if (
      !liveRuns.length ||
      !capabilities ||
      (capabilities.liveEvents !== "sse" && capabilities.liveEvents !== "both")
    ) {
      setLiveState("idle");
      return;
    }
    const stop = liveRuns.map((liveRun) => {
      const afterSequence = Math.max(
        liveRun.sequence,
        liveSequences.current.get(liveRun.runId) ?? -1,
      );
      liveSequences.current.set(liveRun.runId, afterSequence);
      return controlPlane.subscribeRunEvents({
        runId: liveRun.runId,
        afterSequence,
        onStateChange: setLiveState,
        onEvent: (event) => {
          liveSequences.current.set(liveRun.runId, event.sequence);
          liveRefreshAgain.current = true;
          if (liveRefreshPending.current) return;
          liveRefreshPending.current = true;
          void (async () => {
            while (liveRefreshAgain.current) {
              liveRefreshAgain.current = false;
              await reload();
            }
            liveRefreshPending.current = false;
          })();
        },
      });
    });
    return () => {
      for (const close of stop) close();
    };
  }, [capabilities, controlPlane, liveRunsKey, reload]);

  const activeCapability = capabilityFor(route.id);
  const unavailable =
    capabilities &&
    activeCapability &&
    !capabilities.queryResources.includes(activeCapability);
  const viewState = unavailable ? "unsupported" : state;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        {translate(locale, "app.skip")}
      </a>
      <aside className="rail" aria-label="Primary navigation">
        <div className="brand">
          <span className="brand-mark">A²</span>
          <div>
            <strong>{translate(locale, "app.brand")}</strong>
            <small>{translate(locale, "app.controlPlane")}</small>
          </div>
        </div>
        <nav>
          {ROUTES.map((item, index) => {
            const label = translate(locale, ("route." + item.id) as MessageKey);
            return (
              <button
                key={item.id}
                className={
                  route.id === item.id ? "nav-item active" : "nav-item"
                }
                aria-label={label}
                aria-current={route.id === item.id ? "page" : undefined}
                onClick={() => navigate(item.path)}
              >
                <span aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <b>{label}</b>
                  <small>
                    {translate(locale, ("eyebrow." + item.id) as MessageKey)}
                  </small>
                </div>
              </button>
            );
          })}
        </nav>
        <div className="rail-foot">
          <i
            className={
              viewState === "ready" ||
              viewState === "empty" ||
              viewState === "partial"
                ? "signal live"
                : "signal"
            }
          />
          {translate(
            locale,
            viewState === "offline"
              ? "connection.offline"
              : viewState === "stale"
                ? "connection.stale"
                : liveState === "reconnecting"
                  ? "connection.reconnecting"
                  : "connection.controlPlane",
          )}
        </div>
      </aside>
      <main
        id="main"
        tabIndex={-1}
        data-route={route.id}
        data-load-state={viewState}
        data-live-state={liveState}
        data-live-sequence={projectedSequence}
        aria-busy={viewState === "loading"}
      >
        <header className="topbar">
          <div>
            <p>{translate(locale, ("eyebrow." + route.id) as MessageKey)}</p>
            <h1>{translate(locale, ("route." + route.id) as MessageKey)}</h1>
          </div>
          <div className="top-actions">
            <label className="locale-selector">
              {translate(locale, "app.locale")}
              <select
                value={locale}
                onChange={(event) => setLocale(event.target.value as Locale)}
              >
                {SUPPORTED_LOCALES.map((value) => (
                  <option key={value} value={value}>
                    {translate(locale, ("locale." + value) as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
            <span>
              {lastUpdated
                ? translate(locale, "app.updated", {
                    time: new Date(lastUpdated).toLocaleTimeString(locale),
                  })
                : translate(locale, "app.awaiting")}
            </span>
            <button onClick={() => void reload()}>
              {translate(locale, "app.refresh")}
            </button>
          </div>
        </header>
        <Status
          state={viewState}
          message={
            unavailable
              ? route.label + " is unavailable on this Control Plane version."
              : message
          }
          onRetry={reload}
          locale={locale}
        />
        <RouteView
          route={route.id}
          state={viewState}
          data={data}
          capabilities={capabilities}
          controlPlane={controlPlane}
          reload={reload}
          locale={locale}
        />
      </main>
    </div>
  );
}

function Status({
  state,
  message,
  onRetry,
  locale,
}: {
  state: LoadState;
  message: string;
  onRetry(): Promise<unknown>;
  locale: Locale;
}): JSX.Element | null {
  if (state === "ready") return null;
  return (
    <section
      className={"status-panel " + state}
      role={
        state === "error" || state === "offline" || state === "stale"
          ? "alert"
          : "status"
      }
      aria-live="polite"
    >
      <span>{stateLabel(state, locale)}</span>
      <p>{message}</p>
      {["error", "offline", "stale"].includes(state) && (
        <button onClick={() => void onRetry()}>Try again</button>
      )}
    </section>
  );
}

function RouteView(props: {
  route: RouteId;
  state: LoadState;
  data: unknown;
  capabilities?: ControlPlaneCapabilities;
  controlPlane: DashboardControlPlane;
  reload(): Promise<unknown>;
  locale: Locale;
}): JSX.Element {
  if (props.state === "loading") return <Skeleton />;
  if (
    props.state === "error" ||
    props.state === "offline" ||
    props.state === "unsupported"
  )
    return (
      <EmptyScene
        title={
          props.state === "unsupported"
            ? "Capability unavailable"
            : props.route === "administration" && props.state === "error"
              ? "Administrator access required"
              : "State could not be loaded"
        }
        detail={
          props.route === "administration" && props.state === "error"
            ? "The read-only dashboard identity cannot inspect or change security policy. Sign in with an Administrator credential to use this page."
            : "The page never infers durable state from cached deltas. Reconnect to query the Control Plane again."
        }
      />
    );
  if (props.route === "overview")
    return (
      <Overview
        data={props.data}
        capabilities={props.capabilities}
        controlPlane={props.controlPlane}
      />
    );
  if (props.route === "library")
    return <Library data={props.data} controlPlane={props.controlPlane} />;
  if (props.route === "runs")
    return (
      <Runs
        data={props.data}
        capabilities={props.capabilities}
        controlPlane={props.controlPlane}
        reload={props.reload}
      />
    );
  if (props.route === "leaderboard")
    return (
      <Leaderboard
        data={props.data}
        capabilities={props.capabilities}
        controlPlane={props.controlPlane}
      />
    );
  if (props.route === "analysis")
    return (
      <Analysis
        data={props.data}
        capabilities={props.capabilities}
        controlPlane={props.controlPlane}
      />
    );
  if (props.route === "defects")
    return (
      <Defects
        data={props.data}
        capabilities={props.capabilities}
        controlPlane={props.controlPlane}
      />
    );
  if (props.route === "regression")
    return (
      <Regression
        data={props.data}
        capabilities={props.capabilities}
        controlPlane={props.controlPlane}
      />
    );
  if (props.route === "insights")
    return (
      <Insights
        data={props.data}
        capabilities={props.capabilities}
        controlPlane={props.controlPlane}
      />
    );
  if (props.route === "reports")
    return (
      <Reports
        data={props.data}
        capabilities={props.capabilities}
        controlPlane={props.controlPlane}
      />
    );
  if (props.route === "administration")
    return (
      <Administration
        data={props.data}
        capabilities={props.capabilities}
        controlPlane={props.controlPlane}
        locale={props.locale}
        retentionForm={
          <OperatorCommandForm
            title="Set retention policy"
            allowed={["retention.set"]}
            capabilities={props.capabilities}
            controlPlane={props.controlPlane}
          />
        }
      />
    );
  return (
    <ResourceTable
      route={props.route}
      resource={RESOURCES[props.route]}
      data={props.data}
      controlPlane={props.controlPlane}
    />
  );
}

async function loadRoute(
  client: DashboardControlPlane,
  route: RouteId,
  capabilities: ControlPlaneCapabilities,
  signal: AbortSignal,
): Promise<unknown> {
  const require = (resource: string) => {
    if (!capabilities.queryResources.includes(resource))
      throw new Error("Capability unavailable: " + resource);
  };
  if (route === "overview") {
    require("runs");
    const optionalPage = async (
      resource: "workers" | "defects" | "regression-decisions" | "insights",
    ) =>
      capabilities.queryResources.includes(resource)
        ? await client.query<Page>(
            { resource, page: { limit: 8 } } as EvaluationQuery,
            signal,
          )
        : { items: [], page: { hasMore: false, total: 0 } };
    const [runs, workers, defects, regressions, insights, metrics, archive] =
      await Promise.all([
        client.query<Page>({ resource: "runs", page: { limit: 8 } }, signal),
        optionalPage("workers"),
        optionalPage("defects"),
        optionalPage("regression-decisions"),
        optionalPage("insights"),
        capabilities.queryResources.includes("platform-metrics")
          ? client.query({ resource: "platform-metrics" }, signal)
          : Promise.resolve(undefined),
        capabilities.queryResources.includes("archive-summary")
          ? client.query({ resource: "archive-summary" }, signal)
          : Promise.resolve(undefined),
      ]);
    return { runs, workers, defects, regressions, insights, metrics, archive };
  }
  if (route === "library") {
    require("catalog");
    const [datasets, taskPacks, tasks, regressions] = await Promise.all([
      client.query<Page>(
        { resource: "catalog", catalog: "datasets", page: { limit: 100 } },
        signal,
      ),
      client.query<Page>(
        { resource: "catalog", catalog: "task-packs", page: { limit: 100 } },
        signal,
      ),
      client.query<Page>(
        { resource: "catalog", catalog: "tasks", page: { limit: 100 } },
        signal,
      ),
      capabilities.queryResources.includes("regressions")
        ? client.query<Page>(
            { resource: "regressions", page: { limit: 100 } },
            signal,
          )
        : Promise.resolve({ items: [], page: { hasMore: false, total: 0 } }),
    ]);
    return { datasets, taskPacks, tasks, regressions };
  }
  if (route === "leaderboard") {
    require("leaderboard");
    const controls = leaderboardControls();
    if (!controls.sliceManifestHash)
      return { requiresSlice: true, pivot: controls.pivot };
    return await client.query(
      leaderboardQuery(controls, controls.sliceManifestHash),
      signal,
    );
  }
  if (route === "runs") {
    require("runs");
    const parameters = new URLSearchParams(globalThis.location.search);
    const live = await client.query<Page>(
      queryForResource(RESOURCES.runs, parameters),
      signal,
    );
    const [archived, templates, workers] = await Promise.all([
      capabilities.queryResources.includes("archived-runs")
        ? client.query<Page>(
            {
              resource: "archived-runs",
              ...(parameters.get("archiveSearch")
                ? { search: parameters.get("archiveSearch")! }
                : {}),
              page: { limit: 100 },
            },
            signal,
          )
        : Promise.resolve({ items: [], page: { hasMore: false, total: 0 } }),
      capabilities.queryResources.includes("run-templates")
        ? client.query<Page>(
            { resource: "run-templates", page: { limit: 100 } },
            signal,
          )
        : Promise.resolve({ items: [], page: { hasMore: false, total: 0 } }),
      capabilities.queryResources.includes("workers")
        ? client.query<Page>(
            { resource: "workers", page: { limit: 100 } },
            signal,
          )
        : Promise.resolve({ items: [], page: { hasMore: false, total: 0 } }),
    ]);
    return { live, archived, templates, workers };
  }
  if (route === "administration") {
    require("audit");
    const [
      audit,
      workers,
      agents,
      sandboxes,
      verifiers,
      detectors,
      datasets,
      retention,
      administration,
    ] = await Promise.all([
      client.query<Page>({ resource: "audit", page: { limit: 100 } }, signal),
      capabilities.queryResources.includes("workers")
        ? client.query<Page>(
            { resource: "workers", page: { limit: 100 } },
            signal,
          )
        : Promise.resolve({ items: [], page: { hasMore: false, total: 0 } }),
      client.query<Page>(
        { resource: "catalog", catalog: "agents", page: { limit: 100 } },
        signal,
      ),
      client.query<Page>(
        { resource: "catalog", catalog: "sandboxes", page: { limit: 100 } },
        signal,
      ),
      client.query<Page>(
        { resource: "catalog", catalog: "verifiers", page: { limit: 100 } },
        signal,
      ),
      client.query<Page>(
        { resource: "catalog", catalog: "detectors", page: { limit: 100 } },
        signal,
      ),
      client.query<Page>(
        { resource: "catalog", catalog: "datasets", page: { limit: 100 } },
        signal,
      ),
      capabilities.queryResources.includes("retention")
        ? client.query<Page>(
            { resource: "retention", page: { limit: 100 } },
            signal,
          )
        : Promise.resolve({ items: [], page: { hasMore: false, total: 0 } }),
      client.administrationStatus(signal),
    ]);
    return {
      audit,
      workers,
      agents,
      sandboxes,
      verifiers,
      detectors,
      datasets,
      retention,
      administration,
    };
  }
  if (route === "analysis") {
    require("analysis-jobs");
    const parameters = new URLSearchParams(globalThis.location.search);
    const vectorQuery = {
      resource: "capability-vectors",
      ...(parameters.get("runId") ? { runId: parameters.get("runId")! } : {}),
      ...(parameters.get("agentVariantId")
        ? { agentVariantId: parameters.get("agentVariantId")! }
        : {}),
      page: { limit: 100 },
    } as EvaluationQuery;
    const [jobs, defects, capabilityVectors, archive] = await Promise.all([
      client.query<Page>(
        queryForResource(RESOURCES.analysis, parameters),
        signal,
      ),
      capabilities.queryResources.includes("defects")
        ? client.query<Page>(
            { resource: "defects", page: { limit: 100 } },
            signal,
          )
        : Promise.resolve({ items: [], page: { hasMore: false } }),
      capabilities.queryResources.includes("capability-vectors")
        ? client.query<Page>(vectorQuery, signal)
        : Promise.resolve({ items: [], page: { hasMore: false } }),
      capabilities.queryResources.includes("archive-summary")
        ? client.query({ resource: "archive-summary" }, signal)
        : Promise.resolve(undefined),
    ]);
    return { jobs, defects, capabilityVectors, archive };
  }
  if (route === "defects") {
    require("defects");
    const parameters = new URLSearchParams(globalThis.location.search);
    const [defects, reproductions, promotions, archive] = await Promise.all([
      client.query<Page>(
        queryForResource(RESOURCES.defects, parameters),
        signal,
      ),
      capabilities.queryResources.includes("reproductions")
        ? client.query<Page>(
            { resource: "reproductions", page: { limit: 100 } },
            signal,
          )
        : Promise.resolve({ items: [], page: { hasMore: false } }),
      capabilities.queryResources.includes("failure-cluster-promotions")
        ? client.query<Page>(
            { resource: "failure-cluster-promotions", page: { limit: 100 } },
            signal,
          )
        : Promise.resolve({ items: [], page: { hasMore: false } }),
      capabilities.queryResources.includes("archive-summary")
        ? client.query({ resource: "archive-summary" }, signal)
        : Promise.resolve(undefined),
    ]);
    return { defects, reproductions, promotions, archive };
  }
  if (route === "regression") {
    require("regressions");
    const [packs, decisions, archive] = await Promise.all([
      client.query<Page>(
        { resource: "regressions", page: { limit: 100 } },
        signal,
      ),
      capabilities.queryResources.includes("regression-decisions")
        ? client.query<Page>(
            { resource: "regression-decisions", page: { limit: 100 } },
            signal,
          )
        : Promise.resolve({ items: [], page: { hasMore: false } }),
      capabilities.queryResources.includes("archive-summary")
        ? client.query({ resource: "archive-summary" }, signal)
        : Promise.resolve(undefined),
    ]);
    return { packs, decisions, archive };
  }
  if (route === "insights" || route === "reports") {
    const resource = RESOURCES[route];
    require(resource.capability);
    const [live, archive] = await Promise.all([
      client.query(
        queryForResource(
          resource,
          new URLSearchParams(globalThis.location.search),
        ),
        signal,
      ),
      capabilities.queryResources.includes("archive-summary")
        ? client.query({ resource: "archive-summary" }, signal)
        : Promise.resolve(undefined),
    ]);
    return { live, archive };
  }
  throw new Error("Unknown dashboard route: " + String(route));
}

function Overview({
  data,
  capabilities,
  controlPlane,
}: {
  data: unknown;
  capabilities?: ControlPlaneCapabilities;
  controlPlane: DashboardControlPlane;
}): JSX.Element {
  const value = object(data);
  const runs = pageItems(value.runs);
  const workers = pageItems(value.workers);
  const defects = pageItems(value.defects);
  const regressions = pageItems(value.regressions);
  const insights = pageItems(value.insights);
  const metrics = object(value.metrics);
  const archive = object(value.archive);
  const slos = Array.isArray(metrics.slos) ? metrics.slos : [];
  const counts = runs.reduce<Record<string, number>>((all, run) => {
    const state = field(run, "state") || "unknown";
    all[state] = (all[state] ?? 0) + 1;
    return all;
  }, {});
  const usage = runs.reduce<{ tokens: number; cost: number }>(
    (all, run) => ({
      tokens:
        all.tokens +
        Number(path(run, "resourceUsage.inputTokens") ?? 0) +
        Number(path(run, "resourceUsage.outputTokens") ?? 0),
      cost: all.cost + Number(path(run, "resourceUsage.costUsd") ?? 0),
    }),
    { tokens: 0, cost: 0 },
  );
  const blocked = (counts.blocked ?? 0) + (counts.interrupted ?? 0);
  return (
    <div className="content-grid">
      <section className="hero-card">
        <p>Release evidence, not anecdotes.</p>
        <h2>One durable authority for every Agent trial.</h2>
        <div className="hero-metrics">
          <Metric label="Live runs" value={String(runs.length)} />
          <Metric label="Archived runs" value={display(archive.runCount)} />
          <Metric label="Archived trials" value={display(archive.trialCount)} />
          <Metric
            label="Worker utilization"
            value={percent(path(metrics, "workers.utilization"))}
          />
          <Metric
            label="Spend / tokens"
            value={
              "$" +
              Number(path(metrics, "usage.costUsd") ?? usage.cost).toFixed(2) +
              " / " +
              String(
                Number(path(metrics, "usage.inputTokens") ?? 0) +
                  Number(path(metrics, "usage.outputTokens") ?? usage.tokens),
              )
            }
          />
          <Metric
            label="Trace coverage"
            value={
              display(path(metrics, "traceCoverage.trialsWithTrace")) +
              "/" +
              display(path(metrics, "traceCoverage.completedTrials"))
            }
          />
        </div>
      </section>
      <ArchiveConclusions
        archive={archive}
        controlPlane={controlPlane}
        limit={3}
        defaultOpen
      />
      <section className="panel">
        <PanelHeading
          title="Platform metrics"
          eyebrow="Trace and durable projection derived"
        />
        <Rows
          items={[
            {
              metric: "environment prepare p95",
              value: path(metrics, "environmentPreparation.p95Ms"),
              unit: "ms",
            },
            {
              metric: "first model call p95",
              value: path(metrics, "firstModelCall.p95Ms"),
              unit: "ms",
            },
            {
              metric: "tool call p95",
              value: path(metrics, "toolCalls.p95Ms"),
              unit: "ms",
            },
            {
              metric: "artifact upload failures",
              value: path(metrics, "artifacts.uploadFailures"),
              unit: "count",
            },
            {
              metric: "grader failure rate",
              value: path(metrics, "grader.failureRate"),
              unit: "ratio",
            },
            {
              metric: "orchestrator recovery",
              value: path(metrics, "orchestrator.lastRecoveryMs"),
              unit: "ms",
            },
            {
              metric: "flaky task rate",
              value: path(metrics, "flakes.taskRate"),
              unit: "ratio",
            },
          ]}
          fields={["metric", "value", "unit"]}
        />
      </section>
      <OverviewCard
        title="Recent live runs"
        eyebrow="Durable projection"
        path="/runs"
        items={runs}
        fields={["accepted.spec.runId", "state", "updatedAt"]}
        empty="No standalone runs yet"
      />
      <OverviewCard
        title="Archived results"
        eyebrow="Canonical evidence index"
        path="/runs?view=archive"
        items={Array.isArray(archive.latestRuns) ? archive.latestRuns : []}
        fields={[
          "runId",
          "taskPackId",
          "outcome",
          "passedTrials",
          "trialCount",
        ]}
        empty="No archived evidence indexed"
      />
      <OverviewCard
        title="Critical defects"
        eyebrow="Measured failures"
        path="/defects?severity=critical"
        items={defects.filter((item) => field(item, "severity") === "critical")}
        fields={["findingId", "category", "status"]}
        empty="No critical live defects in view"
      />
      <OverviewCard
        title="Release decisions"
        eyebrow="Regression gates"
        path="/regression"
        items={regressions}
        fields={["gateId", "violations", "flakyTasks"]}
        empty="No live release decisions yet"
      />
      <OverviewCard
        title="Validated insights"
        eyebrow="Product impact"
        path="/insights?status=validated"
        items={insights.filter((item) => field(item, "status") === "validated")}
        fields={["insightId", "severity", "owner"]}
        empty="No live validated insights yet"
      />
      <section className="panel accent">
        <PanelHeading
          title="Independent platform SLOs"
          eyebrow="No collapsed pass boolean"
        />
        <div className="attention-score">
          <strong>
            {String(
              slos.filter((slo) => field(slo, "status") === "at_risk").length +
                blocked,
            )}
          </strong>
          <span>at risk or blocked</span>
        </div>
        <Rows
          items={slos}
          fields={["id", "status", "target", "observed", "evidenceRefs"]}
        />
      </section>
    </div>
  );
}

function OverviewCard({
  title,
  eyebrow,
  path: href,
  items,
  fields,
  empty,
}: {
  title: string;
  eyebrow: string;
  path: string;
  items: unknown[];
  fields: string[];
  empty: string;
}): JSX.Element {
  return (
    <section className="panel linked-card">
      <PanelHeading title={title} eyebrow={eyebrow} />
      {items.length ? (
        <Rows items={items} fields={fields} />
      ) : (
        <EmptyScene
          title={empty}
          detail="The authoritative projection currently has no matching records."
        />
      )}
      <a href={href}>Open filtered page →</a>
    </section>
  );
}

function ArchiveConclusions({
  archive,
  controlPlane,
  kinds,
  limit,
  defaultOpen = false,
}: {
  archive: Record<string, unknown>;
  controlPlane: DashboardControlPlane;
  kinds?: string[];
  limit?: number;
  defaultOpen?: boolean;
}): JSX.Element {
  const all = Array.isArray(archive.conclusions) ? archive.conclusions : [];
  const conclusions = all
    .filter((item) => !kinds || kinds.includes(field(item, "kind")))
    .slice(0, limit ?? all.length);
  return (
    <section className="panel archive-conclusions">
      <details open={defaultOpen}>
        <summary className="archive-summary">
          <span>
            <small>Historical evidence</small>
            <strong>Experiment conclusions</strong>
          </span>
          <span className="archive-summary-meta">
            {conclusions.length} shown · {all.length} total
          </span>
        </summary>
        {conclusions.length ? (
          <div className="conclusion-grid">
          {conclusions.map((item, index) => (
            <article
              key={field(item, "conclusionId") || String(index)}
              className={"conclusion-card " + field(item, "status")}
            >
              <header>
                <span>{field(item, "kind")}</span>
                <strong>{field(item, "status")}</strong>
              </header>
              <h3>{field(item, "title")}</h3>
              <p>{field(item, "summary")}</p>
              {field(item, "recommendation") && (
                <blockquote>{field(item, "recommendation")}</blockquote>
              )}
              <dl>
                <dt>Confidence</dt>
                <dd>
                  {field(item, "confidence")
                    ? percent(Number(path(item, "confidence")))
                    : "—"}
                </dd>
                <dt>Runs</dt>
                <dd>{display(path(item, "runIds"))}</dd>
                <dt>Evidence</dt>
                <dd>
                  {Array.isArray(path(item, "evidenceRefs"))
                    ? String((path(item, "evidenceRefs") as unknown[]).length)
                    : "—"}{" "}
                  refs
                </dd>
              </dl>
              {field(item, "sourceDocumentId") && (
                <button
                  type="button"
                  onClick={() => void downloadBlob(
                    () => controlPlane.archiveDocumentBlob(field(item, "sourceDocumentId")),
                    field(item, "sourceDocumentId") + ".json",
                  )}
                >
                  Download authoritative source JSON
                </button>
              )}
            </article>
          ))}
          </div>
        ) : (
          <EmptyScene
            title="No matching conclusions"
            detail="The archive contains no conclusion of this type."
          />
        )}
      </details>
    </section>
  );
}

function ArchivedRunDetailView({
  runId,
  controlPlane,
}: {
  runId: string;
  controlPlane: DashboardControlPlane;
}): JSX.Element {
  const [run, setRun] = useState<unknown>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    setRun(undefined);
    void controlPlane
      .query({ resource: "archived-run", runId }, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setRun(value);
          setError(undefined);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [controlPlane, runId]);
  if (error)
    return (
      <section className="panel">
        <p className="inline-error" role="alert">
          {error}
        </p>
      </section>
    );
  if (!run)
    return (
      <section className="panel">
        <p role="status">Loading archived experiment…</p>
      </section>
    );
  const value = object(run);
  const trials = Array.isArray(value.trials) ? value.trials : [];
  const documents = Array.isArray(value.documents) ? value.documents : [];
  return (
    <section className="panel archived-run-detail" data-archived-run={runId}>
      <PanelHeading
        title={"Archived experiment · " + runId}
        eyebrow="Immutable result, metrics, provenance and conclusion"
      />
      <div className="spec-band">
        <Metric label="Outcome" value={field(run, "outcome")} />
        <Metric
          label="Passed"
          value={field(run, "passedTrials") + "/" + field(run, "trialCount")}
        />
        <Metric label="Failed" value={field(run, "failedTrials")} />
        <Metric label="Task pack" value={field(run, "taskPackId") || "—"} />
        <Metric
          label="Duration"
          value={
            field(run, "durationMs") ? field(run, "durationMs") + " ms" : "—"
          }
        />
        <Metric label="Cleanup" value={field(run, "cleanupVerified") || "—"} />
      </div>
      <h3>Trial outcomes and native verifier metrics</h3>
      <Rows
        items={trials}
        fields={[
          "trialId",
          "taskId",
          "agentVariantId",
          "benchmarkId",
          "outcome",
          "evidenceLevel",
          "nativeMetrics",
          "normalizedEventCount",
          "resultHash",
          "artifactManifestHash",
        ]}
      />
      <h3>Source documents</h3>
      <div className="artifact-links">
        {documents.map((document) => (
          <button
            type="button"
            key={field(document, "documentId")}
            onClick={() => void downloadBlob(
              () => controlPlane.archiveDocumentBlob(field(document, "documentId")),
              field(document, "documentId") + ".json",
            )}
          >
            {field(document, "title")}
            <small>
              {field(document, "kind")} · SHA-256 {field(document, "sha256")} ·{" "}
              {field(document, "bytes")} bytes
            </small>
          </button>
        ))}
      </div>
      <ArchiveConclusions
        archive={{ conclusions: value.conclusions }}
        controlPlane={controlPlane}
      />
    </section>
  );
}

function Library({
  data,
  controlPlane,
}: {
  data: unknown;
  controlPlane: DashboardControlPlane;
}): JSX.Element {
  const value = object(data);
  return (
    <div className="stack">
      <section className="panel">
        <PanelHeading title="Benchmark provenance" eyebrow="Official status is explicit" />
        <p>
          SWE-Bench is a local run of the pinned official harness. Terminal-Bench-compatible,
          ProgramBench-compatible, SWE-Marathon-compatible, and SDLC entries are non-official
          compatible/local task packs; their results must not be presented as official benchmark results.
        </p>
      </section>
      <CatalogPanel
        title="Datasets"
        catalog="datasets"
        initial={value.datasets}
        fields={[
          "displayName",
          "version",
          "split",
          "totalItems",
          "officialBenchmark",
          "policy.license.status",
          "policy.permissions.evaluation.status",
          "policy.permissions.training.status",
          "policy.sourceProvenance.status",
          "policy.publication.redistribution.status",
        ]}
        controlPlane={controlPlane}
      />
      <section className="split">
        <CatalogPanel
          title="Task packs"
          catalog="task-packs"
          initial={value.taskPacks}
          fields={[
            "id",
            "version",
            "evaluatedSlice.selectionKind",
            "evaluatedSlice.selectedItems",
            "evaluatedSlice.coverageRatio",
            "evaluatedSlice.sliceManifestHash",
            "policy.license.status",
            "policy.permissions.evaluation.status",
            "policy.permissions.training.status",
            "policy.sourceProvenance.status",
            "policy.publication.artifact.status",
            "policy.publication.report.status",
            "policy.publication.leaderboard.status",
            "policy.publication.redistribution.status",
          ]}
          controlPlane={controlPlane}
        />
        <CatalogPanel
          title="Resolved tasks"
          catalog="tasks"
          initial={value.tasks}
          fields={[
            "taskId",
            "taskPackId",
            "title",
            "policy.license.status",
            "policy.permissions.evaluation.status",
            "policy.permissions.training.status",
            "policy.sourceProvenance.status",
          ]}
          controlPlane={controlPlane}
        />
      </section>
      <section className="panel">
        <PanelHeading
          title="Regression packs"
          eyebrow="Ownership, coverage & flake policy"
        />
        <Rows
          items={pageItems(value.regressions)}
          fields={[
            "packId",
            "version",
            "owner",
            "severity",
            "allowedFlakeRate",
            "taskPackRef",
          ]}
        />
      </section>
    </div>
  );
}

function CatalogPanel({
  title,
  catalog,
  initial,
  fields,
  controlPlane,
}: {
  title: string;
  catalog: "datasets" | "task-packs" | "tasks";
  initial: unknown;
  fields: string[];
  controlPlane: DashboardControlPlane;
}): JSX.Element {
  const [result, setResult] = useState<Page>(
    isPage(initial) ? initial : { items: [], page: { hasMore: false } },
  );
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async (cursor?: string, append = false) => {
    setBusy(true);
    try {
      const loaded = await controlPlane.query<Page>({
        resource: "catalog",
        catalog,
        page: { limit: 100, ...(cursor ? { cursor } : {}) },
        ...(search.trim() ? { search: search.trim() } : {}),
      });
      setResult(
        append
          ? { items: [...result.items, ...loaded.items], page: loaded.page }
          : loaded,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel catalog-panel">
      <PanelHeading title={title} eyebrow="Server-filtered immutable catalog" />
      <div className="inline-filter">
        <label>
          Search
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button disabled={busy} onClick={() => void load()}>
          Search
        </button>
      </div>
      <Rows items={result.items} fields={fields} />
      {result.page.hasMore && (
        <div className="pagination-bar">
          <span>
            {result.items.length} of {result.page.total ?? "more"}
          </span>
          <button
            disabled={busy || !result.page.nextCursor}
            onClick={() => void load(result.page.nextCursor, true)}
          >
            Load next page
          </button>
        </div>
      )}
    </section>
  );
}

type LeaderboardControls = {
  pivot: "model" | "agent_type" | "test_dataset";
  sliceManifestHash: string;
  view: "active" | "audit";
  agentType: "" | "agent-runlab" | "claude-code" | "codex";
  modelId: string;
  sortBy:
    | "primary_metric"
    | "cost"
    | "p50_duration"
    | "p95_duration"
    | "published_at";
  sortDirection: "asc" | "desc";
};

function Leaderboard({
  data,
  capabilities,
  controlPlane,
}: {
  data: unknown;
  capabilities?: ControlPlaneCapabilities;
  controlPlane: DashboardControlPlane;
}): JSX.Element {
  const initialControls = leaderboardControls();
  const [controls, setControls] = useState(initialControls);
  const [result, setResult] = useState(data);
  const [comparisonHash, setComparisonHash] = useState(
    new URLSearchParams(globalThis.location.search).get(
      "compareSliceManifestHash",
    ) ?? "",
  );
  const [comparisonWarning, setComparisonWarning] = useState<string>();
  const [comparison, setComparison] = useState<unknown>();
  const [error, setError] = useState<string>();
  useEffect(() => setResult(data), [data]);
  const load = async () => {
    const exactSliceHash = controls.sliceManifestHash.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(exactSliceHash)) {
      setError(
        "Enter an exact 64-character evaluated-slice SHA-256. Boards never mix unlike denominators.",
      );
      return;
    }
    try {
      const loaded = await controlPlane.query(
        leaderboardQuery(controls, exactSliceHash),
      );
      const url = new URL(globalThis.location.href);
      writeLeaderboardControls(url, {
        ...controls,
        sliceManifestHash: exactSliceHash,
      });
      globalThis.history.replaceState({}, "", url);
      setControls((current) => ({
        ...current,
        sliceManifestHash: exactSliceHash,
      }));
      setResult(loaded);
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const previewComparison = () => {
    const requested = comparisonHash.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(requested)) {
      setError(
        "Exploratory comparison requires an exact 64-character evaluated-slice SHA-256.",
      );
      return;
    }
    if (requested === controls.sliceManifestHash.trim().toLowerCase()) {
      setError("The exploratory slice must differ from the ranked slice.");
      return;
    }
    setComparisonWarning(requested);
    setComparison(undefined);
    setError(undefined);
  };
  const loadComparison = async () => {
    if (!comparisonWarning) return;
    try {
      const loaded = await controlPlane.query(
        leaderboardQuery({ ...controls, view: "active" }, comparisonWarning),
      );
      const url = new URL(globalThis.location.href);
      url.searchParams.set("compareSliceManifestHash", comparisonWarning);
      globalThis.history.replaceState({}, "", url);
      setComparison(loaded);
      setComparisonHash(comparisonWarning);
      setComparisonWarning(undefined);
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const items = pageItems(result);
  const requiresSlice = object(result).requiresSlice === true;
  const contentState = requiresSlice ? "ready" : classifyLoadedState(result);
  const exactSlice = leaderboardSlice(items[0]);
  const exactHash =
    exactSlice?.sliceManifestHash ??
    (/^[a-f0-9]{64}$/iu.test(controls.sliceManifestHash.trim())
      ? controls.sliceManifestHash.trim().toLowerCase()
      : undefined);
  const sliceLabel = exactSlice
    ? formatEvaluatedSliceLabel(exactSlice) +
      " (" +
      formatPercent(exactSlice.coverageRatio) +
      ")"
    : exactHash
      ? "Exact slice " + exactHash
      : "Choose one exact evaluated slice";
  const comparisonItems = pageItems(comparison);
  return (
    <div
      className="stack leaderboard-view"
      data-content-state={contentState}
      data-pivot={controls.pivot}
      data-view={controls.view}
      data-slice-manifest-hash={exactHash}
    >
      <section className="filter-bar leaderboard-filters">
        <div className="segmented" aria-label="Leaderboard pivot">
          {(["model", "agent_type", "test_dataset"] as const).map((value) => (
            <button
              key={value}
              aria-pressed={controls.pivot === value}
              onClick={() => setControls({ ...controls, pivot: value })}
            >
              {value.replace("_", " ")}
            </button>
          ))}
        </div>
        <label>
          Board view
          <select
            value={controls.view}
            onChange={(event) =>
              setControls({
                ...controls,
                view: event.target.value as LeaderboardControls["view"],
              })
            }
          >
            <option value="active">Active rank</option>
            <option value="audit">Inactive audit</option>
          </select>
        </label>
        <label>
          Agent type
          <select
            value={controls.agentType}
            onChange={(event) =>
              setControls({
                ...controls,
                agentType: event.target
                  .value as LeaderboardControls["agentType"],
              })
            }
          >
            <option value="">All</option>
            <option value="agent-runlab">Agent RunLab</option>
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <label>
          Model
          <input
            value={controls.modelId}
            onChange={(event) =>
              setControls({ ...controls, modelId: event.target.value })
            }
          />
        </label>
        <label>
          Sort
          <select
            value={controls.sortBy}
            onChange={(event) =>
              setControls({
                ...controls,
                sortBy: event.target.value as LeaderboardControls["sortBy"],
              })
            }
          >
            <option value="primary_metric">Primary metric</option>
            <option value="cost">Cost</option>
            <option value="p50_duration">p50 duration</option>
            <option value="p95_duration">p95 duration</option>
            <option value="published_at">Published</option>
          </select>
        </label>
        <label>
          Direction
          <select
            value={controls.sortDirection}
            onChange={(event) =>
              setControls({
                ...controls,
                sortDirection: event.target
                  .value as LeaderboardControls["sortDirection"],
              })
            }
          >
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </label>
        <label className="wide-control">
          Slice manifest
          <input
            value={controls.sliceManifestHash}
            onChange={(event) =>
              setControls({
                ...controls,
                sliceManifestHash: event.target.value,
              })
            }
            placeholder="64-character SHA-256"
            spellCheck={false}
          />
        </label>
        <button className="primary" onClick={() => void load()}>
          Load board
        </button>
      </section>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <section className="slice-badge" aria-label="Active evaluated slice">
        <span>Authoritative denominator</span>
        <strong>{sliceLabel}</strong>
        {exactHash && <code>{exactHash}</code>}
      </section>
      {contentState === "partial" && (
        <p className="partial-note" role="status">
          Showing the first authoritative page. More entries are available for
          this exact slice.
        </p>
      )}
      <section className="panel">
        <PanelHeading
          title={
            controls.view === "active"
              ? "Ranked entries"
              : "Invalidated & superseded audit"
          }
          eyebrow={
            controls.view === "active"
              ? "Native primary metric"
              : "Visually excluded from active rank"
          }
        />
        {requiresSlice ? (
          <EmptyScene
            title="Select an evaluated slice"
            detail="Enter its immutable manifest hash. The board will never combine entries from different denominators."
          />
        ) : (
          <LeaderboardRows items={items} ranked={controls.view === "active"} />
        )}
        {exactHash && items.length > 0 && (
          <LeaderboardExports items={items} sliceManifestHash={exactHash} />
        )}
      </section>
      <section className="panel exploratory-comparison">
        <PanelHeading
          title="Cross-slice exploration"
          eyebrow="Never directly rank-comparable"
        />
        <div className="inline-filter">
          <label>
            Other slice manifest
            <input
              value={comparisonHash}
              onChange={(event) => {
                setComparisonHash(event.target.value);
                setComparison(undefined);
                setComparisonWarning(undefined);
              }}
              placeholder="Different 64-character SHA-256"
              spellCheck={false}
            />
          </label>
          <button onClick={previewComparison}>Preview warning</button>
        </div>
        {comparisonWarning && (
          <div className="comparability-warning" role="alert">
            <strong>Not directly rank-comparable</strong>
            <p>
              The requested slice has a different immutable denominator. It will
              appear in a separate unranked group and will never receive a
              shared rank.
            </p>
            <button className="primary" onClick={() => void loadComparison()}>
              I understand · load unranked comparison
            </button>
          </div>
        )}
        {comparisonItems.length > 0 && (
          <div
            className="comparison-group"
            data-comparison-slice={comparisonHash}
          >
            <div className="slice-badge">
              <span>Exploratory denominator · no shared rank</span>
              <strong>
                {leaderboardSlice(comparisonItems[0])
                  ? formatEvaluatedSliceLabel(
                      leaderboardSlice(comparisonItems[0])!,
                    )
                  : comparisonHash}
              </strong>
              <code>{comparisonHash}</code>
            </div>
            <LeaderboardRows items={comparisonItems} ranked={false} />
          </div>
        )}
      </section>
      <OperatorCommandForm
        title="Invalidate published entry"
        allowed={["leaderboard.invalidate"]}
        capabilities={capabilities}
        controlPlane={controlPlane}
      />
    </div>
  );
}

function LeaderboardRows({
  items,
  ranked,
}: {
  items: unknown[];
  ranked: boolean;
}): JSX.Element {
  const entries = items.flatMap((item) => {
    const parsed = item as LeaderboardEntry;
    return leaderboardSlice(parsed) ? [parsed] : [];
  });
  const [expanded, setExpanded] = useState<string>();
  const rowHeight = 38;
  const viewportRows = 14;
  const overscan = 5;
  const virtualized = entries.length > 40;
  const [scrollTop, setScrollTop] = useState(0);
  if (!entries.length)
    return (
      <EmptyScene
        title={
          ranked ? "No active ranked entries" : "No inactive audit entries"
        }
        detail={
          ranked
            ? "No eligible active publication matches this exact slice and filter."
            : "No invalidated or superseded publication matches this exact slice and filter."
        }
      />
    );
  const start = virtualized
    ? Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
    : 0;
  const end = virtualized
    ? Math.min(entries.length, start + viewportRows + overscan * 2)
    : entries.length;
  const visible = entries.slice(start, end);
  const columns = [
    "rank",
    "entry",
    "primary metric",
    "CI",
    "repeats",
    "completed / expected",
    "cost",
    "p50",
    "p95",
    "evidence",
    "Agent version",
    "model version",
    "verifier",
    "published",
    "status",
  ];
  return (
    <div
      className="table-wrap leaderboard-table"
      tabIndex={0}
      role="region"
      aria-label={
        ranked
          ? "Scrollable ranked Leaderboard table"
          : "Scrollable inactive Leaderboard audit table"
      }
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      data-virtualized={virtualized}
      data-total-rows={entries.length}
      data-rendered-rows={visible.length}
    >
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {virtualized && start > 0 && (
            <tr aria-hidden="true" className="virtual-spacer">
              <td
                colSpan={columns.length}
                style={{ height: start * rowHeight }}
              />
            </tr>
          )}
          {visible.flatMap((entry, visibleIndex) => {
            const index = start + visibleIndex;
            const open = expanded === entry.entryId;
            const label = leaderboardRowLabel(
              entry,
              ranked ? index + 1 : undefined,
            );
            const row = (
              <tr
                key={entry.entryId}
                className={
                  entry.status === "active" ? undefined : "inactive-entry"
                }
              >
                <td>{ranked ? "#" + String(index + 1) : "—"}</td>
                <td>
                  <button
                    className="row-expander"
                    aria-expanded={open}
                    onClick={() =>
                      setExpanded(open ? undefined : entry.entryId)
                    }
                  >
                    {label}
                  </button>
                </td>
                <td>
                  {entry.primaryMetric.value} {entry.primaryMetric.unit}
                </td>
                <td>{display(entry.confidenceInterval)}</td>
                <td>{entry.repeats}</td>
                <td>
                  {entry.completedTrials}/{entry.expectedTrials}
                </td>
                <td>{display(entry.secondaryMetrics.costUsd)}</td>
                <td>{display(entry.secondaryMetrics.p50DurationMs)}</td>
                <td>{display(entry.secondaryMetrics.p95DurationMs)}</td>
                <td>{entry.evidenceLevel}</td>
                <td>{entry.agent.version}</td>
                <td>{entry.model.modelVersion ?? "—"}</td>
                <td>{entry.verifierVersion}</td>
                <td>{entry.publishedAt}</td>
                <td>{entry.status}</td>
              </tr>
            );
            if (!open) return [row];
            const runId = entry.runRefs[0]!;
            return [
              row,
              <tr
                key={entry.entryId + "-details"}
                className="leaderboard-details"
              >
                <td colSpan={columns.length}>
                  <div>
                    <strong>Exact comparability identity</strong>
                    <code>{leaderboardComparabilityKey(entry)}</code>
                    <nav aria-label={"Evidence links for " + entry.entryId}>
                      <a href={"/runs?runId=" + encodeURIComponent(runId)}>
                        Contributing runs
                      </a>
                      <a
                        href={
                          "/runs?runId=" +
                          encodeURIComponent(runId) +
                          "&trialState=completed"
                        }
                      >
                        Task-level results
                      </a>
                      <a href={"/reports?runId=" + encodeURIComponent(runId)}>
                        Methodology
                      </a>
                      <a
                        href={
                          "/runs?runId=" +
                          encodeURIComponent(runId) +
                          "&trialId="
                        }
                      >
                        Artifacts
                      </a>
                    </nav>
                  </div>
                </td>
              </tr>,
            ];
          })}
          {virtualized && end < entries.length && (
            <tr aria-hidden="true" className="virtual-spacer">
              <td
                colSpan={columns.length}
                style={{ height: (entries.length - end) * rowHeight }}
              />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function LeaderboardExports({
  items,
  sliceManifestHash,
}: {
  items: unknown[];
  sliceManifestHash: string;
}): JSX.Element {
  const entries = items as LeaderboardEntry[];
  const exportedAt = new Date().toISOString();
  const json = JSON.stringify(
    {
      schemaVersion: 1,
      exportedAt,
      sliceManifestHash,
      comparabilityKeys: [...new Set(entries.map(leaderboardComparabilityKey))],
      entries,
    },
    null,
    2,
  );
  const headings = [
    "entryId",
    "status",
    "rank",
    "agentType",
    "agentVersion",
    "modelId",
    "modelVersion",
    "primaryMetric",
    "primaryValue",
    "unit",
    "selectedItems",
    "totalItems",
    "coverageRatio",
    "sliceManifestHash",
    "verifierVersion",
    "repeatPolicyHash",
    "evidenceLevel",
    "runRefs",
  ];
  const rows = entries.map((entry, index) => [
    entry.entryId,
    entry.status,
    entry.status === "active" ? index + 1 : "",
    entry.agent.type,
    entry.agent.version,
    entry.model.modelId,
    entry.model.modelVersion ?? "",
    entry.primaryMetric.name,
    entry.primaryMetric.value,
    entry.primaryMetric.unit,
    entry.evaluatedSlice.selectedItems,
    entry.evaluatedSlice.dataset.totalItems,
    entry.evaluatedSlice.coverageRatio,
    entry.evaluatedSlice.sliceManifestHash,
    entry.verifierVersion,
    entry.repeatPolicyHash,
    entry.evidenceLevel,
    entry.runRefs.join("|"),
  ]);
  const csv =
    [headings, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") +
    "\n";
  return (
    <div
      className="leaderboard-exports"
      aria-label="Leaderboard provenance exports"
    >
      <span>Exact-slice export</span>
      <a
        download={"leaderboard-" + sliceManifestHash + ".csv"}
        href={"data:text/csv;charset=utf-8," + encodeURIComponent(csv)}
      >
        CSV
      </a>
      <a
        download={"leaderboard-" + sliceManifestHash + ".json"}
        href={"data:application/json;charset=utf-8," + encodeURIComponent(json)}
      >
        JSON
      </a>
    </div>
  );
}

function leaderboardRowLabel(entry: LeaderboardEntry, rank?: number): string {
  const slice = entry.evaluatedSlice;
  return (
    (rank ? "#" + String(rank) + " " : "") +
    entry.agent.type +
    " · " +
    entry.model.modelId +
    " · " +
    slice.dataset.displayName +
    " / " +
    slice.sliceId +
    " · " +
    String(slice.selectedItems) +
    "/" +
    String(slice.dataset.totalItems) +
    " (" +
    formatPercent(slice.coverageRatio) +
    ")"
  );
}
function csvCell(value: unknown): string {
  const text = String(value);
  return /[",\n\r]/u.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

type DeletionImpact = {
  impactHash: string;
  derivedResourceIds: string[];
  blockedByRefs: string[];
};
type OperatorIntent = {
  action: "cancel" | "publish" | "delete";
  runId: string;
  impact?: DeletionImpact;
};

function Runs({
  data,
  capabilities,
  controlPlane,
  reload,
}: {
  data: unknown;
  capabilities?: ControlPlaneCapabilities;
  controlPlane: DashboardControlPlane;
  reload(): Promise<unknown>;
}): JSX.Element {
  const value = object(data);
  const items = pageItems(value.live ?? data);
  const archivedItems = pageItems(value.archived);
  const templates = pageItems(value.templates);
  const workers = pageItems(value.workers);
  const firstRunId = items.map(runIdFrom).find(Boolean) ?? "";
  const firstArchivedRunId =
    archivedItems.map((item) => field(item, "runId")).find(Boolean) ?? "";
  const requestedRunId =
    new URLSearchParams(globalThis.location.search).get("runId") ?? "";
  const [selectedRunId, setSelectedRunId] = useState(
    requestedRunId || firstRunId,
  );
  const [selectedArchivedRunId, setSelectedArchivedRunId] = useState(
    new URLSearchParams(globalThis.location.search).get("archiveRunId") ??
      firstArchivedRunId,
  );
  const [session] = useState(() => operatorSession());
  const [recent, setRecent] = useState<StoredOperatorCommand | undefined>(() =>
    loadOperatorCommand(),
  );
  const [intent, setIntent] = useState<OperatorIntent>();
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const confirmationInput = useRef<HTMLInputElement>(null);
  const confirmationDialog = useRef<HTMLElement>(null);
  const dialogOpener = useRef<HTMLElement>();
  useEffect(() => {
    if (!selectedRunId && firstRunId) setSelectedRunId(firstRunId);
  }, [firstRunId, selectedRunId]);
  useEffect(() => {
    if (!selectedArchivedRunId && firstArchivedRunId)
      setSelectedArchivedRunId(firstArchivedRunId);
  }, [firstArchivedRunId, selectedArchivedRunId]);
  useEffect(() => {
    if (intent) confirmationInput.current?.focus();
    else dialogOpener.current?.focus();
  }, [intent]);

  const supports = (command: string) =>
    capabilities?.commands.includes(command) ?? false;
  const begin = async (
    action: OperatorIntent["action"],
    opener: HTMLElement,
  ) => {
    if (!selectedRunId || busy) return;
    dialogOpener.current = opener;
    setBusy(true);
    setError(undefined);
    setConfirmation("");
    try {
      const impact =
        action === "delete"
          ? await controlPlane.query<DeletionImpact>({
              resource: "deletion-impact",
              runId: selectedRunId,
            })
          : undefined;
      setIntent({
        action,
        runId: selectedRunId,
        ...(impact ? { impact } : {}),
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const execute = async (command: EvaluationCommand): Promise<boolean> => {
    const pending = saveOperatorCommand({
      schemaVersion: 1,
      sessionId: session.sessionId,
      command,
      state: "pending",
      updatedAt: new Date().toISOString(),
    });
    setRecent(pending);
    setBusy(true);
    setError(undefined);
    try {
      const acknowledgement = await controlPlane.command(command);
      const committed = saveOperatorCommand({
        ...pending,
        state: "committed",
        acknowledgement,
        updatedAt: new Date().toISOString(),
      });
      setRecent(committed);
      setIntent(undefined);
      setConfirmation("");
      await reload();
      return true;
    } catch (cause) {
      const message = errorMessage(cause);
      const failed = saveOperatorCommand({
        ...pending,
        state: "failed",
        error: message,
        updatedAt: new Date().toISOString(),
      });
      setRecent(failed);
      setError(message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!intent || confirmation !== confirmationText(intent)) return;
    const envelope = operatorCommandEnvelope(session);
    const command: EvaluationCommand =
      intent.action === "cancel"
        ? {
            ...envelope,
            type: "run.cancel",
            runId: intent.runId,
            reason: "confirmed by local operator session " + session.sessionId,
          }
        : intent.action === "publish"
          ? { ...envelope, type: "leaderboard.publish", runId: intent.runId }
          : {
              ...envelope,
              type: "run.delete",
              runId: intent.runId,
              expectedImpactHash: intent.impact!.impactHash,
              confirmation: "delete:" + intent.runId,
            };
    await execute(command);
  };
  const retry = async () => {
    if (recent && recent.state !== "committed") await execute(recent.command);
  };
  const blocked =
    intent?.action === "delete" &&
    (intent.impact?.blockedByRefs.length ?? 0) > 0;
  const selectRun = (runId: string) => {
    setSelectedRunId(runId);
    const url = new URL(globalThis.location.href);
    if (runId) url.searchParams.set("runId", runId);
    else url.searchParams.delete("runId");
    url.searchParams.delete("trialId");
    globalThis.history.replaceState({}, "", url);
  };

  return (
    <div className="stack">
      <section
        className="operator-strip"
        data-operator-session={session.sessionId}
      >
        <div>
          <span>Operator session</span>
          <code>{session.sessionId}</code>
        </div>
        <label>
          Active live run
          <select
            value={selectedRunId}
            onChange={(event) => selectRun(event.target.value)}
          >
            <option value="">No live run selected</option>
            {items.map((item) => {
              const runId = runIdFrom(item);
              return runId ? (
                <option key={runId} value={runId}>
                  {runId}
                </option>
              ) : null;
            })}
          </select>
        </label>
        <div className="operator-actions">
          <button
            disabled={!selectedRunId || !supports("run.cancel") || busy}
            onClick={(event) => void begin("cancel", event.currentTarget)}
          >
            Cancel run
          </button>
          <button
            disabled={
              !selectedRunId || !supports("leaderboard.publish") || busy
            }
            onClick={(event) => void begin("publish", event.currentTarget)}
          >
            Publish run
          </button>
          <button
            className="danger"
            disabled={!selectedRunId || !supports("run.delete") || busy}
            onClick={(event) => void begin("delete", event.currentTarget)}
          >
            Delete run
          </button>
        </div>
      </section>
      {recent && (
        <section
          className={"command-status " + recent.state}
          role="status"
          data-command-state={recent.state}
        >
          <span>
            {recent.state === "committed"
              ? "Committed"
              : recent.state === "failed"
                ? "Command failed"
                : "Submitting"}
          </span>
          <code>
            {recent.command.type} · {recent.command.idempotencyKey}
          </code>
          {recent.state !== "committed" && (
            <button disabled={busy} onClick={() => void retry()}>
              {recent.state === "failed"
                ? "Retry same command"
                : "Resume same command"}
            </button>
          )}
        </section>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <RunCreation
        capabilities={capabilities}
        templates={templates}
        workers={workers}
        busy={busy}
        execute={execute}
        onCreated={selectRun}
      />
      <section className="panel">
        <PanelHeading
          title="Evaluation runs"
          eyebrow="Live mutable Control Plane state"
        />
        {items.length ? (
          <Rows items={items} fields={RESOURCES.runs.columns} />
        ) : (
          <EmptyScene
            title="No live evaluation runs"
            detail="Create a resolved run specification; a registered Worker will execute it after start."
          />
        )}
      </section>
      {selectedRunId && (
        <RunDetail
          runId={selectedRunId}
          capabilities={capabilities}
          controlPlane={controlPlane}
          busy={busy}
          execute={execute}
          refreshToken={
            field(
              items.find((item) => runIdFrom(item) === selectedRunId),
              "updatedAt",
            ) +
            "|" +
            field(
              items.find((item) => runIdFrom(item) === selectedRunId),
              "state",
            )
          }
        />
      )}
      <section className="panel archive-index">
        <PanelHeading
          title="Existing experiment results"
          eyebrow="Read-only canonical evidence archive"
        />
        {archivedItems.length ? (
          <>
            <label className="trial-selector">
              Archived run
              <select
                value={selectedArchivedRunId}
                onChange={(event) => {
                  const runId = event.target.value;
                  setSelectedArchivedRunId(runId);
                  const url = new URL(globalThis.location.href);
                  if (runId) url.searchParams.set("archiveRunId", runId);
                  else url.searchParams.delete("archiveRunId");
                  globalThis.history.replaceState({}, "", url);
                }}
              >
                {archivedItems.map((run) => (
                  <option key={field(run, "runId")} value={field(run, "runId")}>
                    {field(run, "taskPackId") || "evaluation"} ·{" "}
                    {field(run, "runId")} · {field(run, "outcome")}
                  </option>
                ))}
              </select>
            </label>
            <Rows
              items={archivedItems}
              fields={[
                "runId",
                "taskPackId",
                "state",
                "outcome",
                "passedTrials",
                "failedTrials",
                "trialCount",
                "durationMs",
                "cleanupVerified",
                "completedAt",
              ]}
            />
          </>
        ) : (
          <EmptyScene
            title="No archived experiments"
            detail="No new-platform canonical evidence files were indexed."
          />
        )}
      </section>
      {selectedArchivedRunId && (
        <ArchivedRunDetailView
          runId={selectedArchivedRunId}
          controlPlane={controlPlane}
        />
      )}
      {intent && (
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy)
              setIntent(undefined);
          }}
        >
          <section
            ref={confirmationDialog}
            className="confirmation-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirmation-title"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !busy) setIntent(undefined);
              if (event.key === "Tab") {
                const focusable = Array.from(
                  confirmationDialog.current?.querySelectorAll<HTMLElement>(
                    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
                  ) ?? [],
                );
                const first = focusable[0];
                const last = focusable.at(-1);
                if (!first || !last) return;
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first.focus();
                }
              }
            }}
          >
            <p>Safety confirmation</p>
            <h2 id="confirmation-title">
              {intent.action === "delete"
                ? "Delete run and derived resources"
                : intent.action === "publish"
                  ? "Publish ranked evidence"
                  : "Cancel active run"}
            </h2>
            <p>
              {intent.action === "delete"
                ? "This preview came from the authoritative Control Plane. The impact hash is bound to the command."
                : "The command will be submitted with a persistent idempotency key and committed acknowledgement."}
            </p>
            {intent.impact && (
              <dl className="impact-preview">
                <dt>Impact hash</dt>
                <dd>
                  <code>{intent.impact.impactHash}</code>
                </dd>
                <dt>Derived resources</dt>
                <dd>{intent.impact.derivedResourceIds.length}</dd>
                <dt>Protected references</dt>
                <dd>
                  {intent.impact.blockedByRefs.length
                    ? intent.impact.blockedByRefs.join(", ")
                    : "none"}
                </dd>
              </dl>
            )}
            <label>
              Type <code>{confirmationText(intent)}</code> to confirm
              <input
                ref={confirmationInput}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="dialog-actions">
              <button disabled={busy} onClick={() => setIntent(undefined)}>
                Back
              </button>
              <button
                className={intent.action === "delete" ? "danger" : "primary"}
                disabled={
                  busy || blocked || confirmation !== confirmationText(intent)
                }
                onClick={() => void submit()}
              >
                Confirm {intent.action}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function RunCreation({
  capabilities,
  templates: rawTemplates,
  workers,
  busy,
  execute,
  onCreated,
}: {
  capabilities?: ControlPlaneCapabilities;
  templates: unknown[];
  workers: unknown[];
  busy: boolean;
  execute(command: EvaluationCommand): Promise<boolean>;
  onCreated(runId: string): void;
}): JSX.Element {
  const templates = rawTemplates.flatMap((value) => {
    const parsed = EvaluationRunTemplateSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  const initialTemplate =
    templates.find((template) => template.recommended) ?? templates[0];
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"template" | "json">(
    templates.length ? "template" : "json",
  );
  const [templateId, setTemplateId] = useState(
    initialTemplate?.templateId ?? "",
  );
  const [runId, setRunId] = useState(() =>
    freshWebRunId(initialTemplate?.templateId ?? "evaluation"),
  );
  const [agentVariantId, setAgentVariantId] = useState(
    initialTemplate?.spec.agents[0]?.variantId ?? "",
  );
  const [repeats, setRepeats] = useState(
    initialTemplate?.spec.execution.repeats ?? 1,
  );
  const [timeoutSeconds, setTimeoutSeconds] = useState(() =>
    Math.ceil((initialTemplate?.spec.execution.timeoutMs ?? 600_000) / 1_000),
  );
  const [maxConcurrency, setMaxConcurrency] = useState(
    initialTemplate?.spec.execution.maxConcurrency ?? 1,
  );
  const [budgetUsd, setBudgetUsd] = useState(() => {
    const value = initialTemplate?.spec.execution.budget?.maxUsd;
    return value === undefined ? "" : String(value);
  });
  const [draft, setDraft] = useState("");
  const [spec, setSpec] = useState<EvaluationRunSpec>();
  const [error, setError] = useState<string>();
  const selectedTemplate = templates.find(
    (template) => template.templateId === templateId,
  );
  const templateAgent =
    selectedTemplate?.spec.agents.find(
      (agent) => agent.variantId === agentVariantId,
    ) ?? selectedTemplate?.spec.agents[0];
  const compatibleWorkers = spec
    ? workers.filter((worker) => workerSupportsSpec(worker, spec))
    : [];
  const onlineWorkers = compatibleWorkers.filter(workerIsOnline);
  const readinessDiagnostics = spec
    ? workers
        .filter(workerIsOnline)
        .flatMap((worker) => workerReadinessDiagnostics(worker, spec))
    : [];

  const selectTemplate = (nextId: string) => {
    const template = templates.find((item) => item.templateId === nextId);
    setTemplateId(nextId);
    setSpec(undefined);
    setError(undefined);
    if (!template) return;
    setRunId(freshWebRunId(template.templateId));
    setAgentVariantId(template.spec.agents[0]?.variantId ?? "");
    setRepeats(template.spec.execution.repeats);
    setTimeoutSeconds(Math.ceil(template.spec.execution.timeoutMs / 1_000));
    setMaxConcurrency(template.spec.execution.maxConcurrency);
    setBudgetUsd(
      template.spec.execution.budget?.maxUsd === undefined
        ? ""
        : String(template.spec.execution.budget.maxUsd),
    );
  };
  useEffect(() => {
    if (selectedTemplate && !agentVariantId)
      setAgentVariantId(selectedTemplate.spec.agents[0]?.variantId ?? "");
  }, [agentVariantId, selectedTemplate]);

  const validate = () => {
    try {
      const candidate =
        mode === "json"
          ? JSON.parse(draft)
          : buildTemplateSpec({
              template: selectedTemplate,
              runId,
              agentVariantId: templateAgent?.variantId ?? "",
              repeats,
              timeoutSeconds,
              maxConcurrency,
              budgetUsd,
            });
      const parsed = EvaluationRunSpecSchema.parse(candidate);
      setSpec(parsed);
      setError(undefined);
    } catch (cause) {
      setSpec(undefined);
      setError(errorMessage(cause));
    }
  };
  const submit = async (start: boolean) => {
    if (!spec) return;
    const created = await execute({
      ...operatorCommandEnvelope(operatorSession()),
      type: "run.create",
      spec,
    });
    if (!created) return;
    onCreated(spec.runId);
    if (start) {
      const started = await execute({
        ...operatorCommandEnvelope(operatorSession()),
        type: "run.start",
        runId: spec.runId,
      });
      if (!started) return;
    }
    setOpen(false);
    setDraft("");
    setSpec(undefined);
  };
  return (
    <section className="panel run-creation">
      <PanelHeading
        title="Create immutable run"
        eyebrow="Resolved specification required"
      />
      {!open ? (
        <div className="action-callout">
          <p>
            A benchmark name alone is never enough. Validate the complete
            canonical spec before submission.
          </p>
          <button
            disabled={!capabilities?.commands.includes("run.create")}
            onClick={() => setOpen(true)}
          >
            New run specification
          </button>
        </div>
      ) : (
        <div className="stack">
          {templates.length > 0 && (
            <div
              className="creation-mode"
              role="group"
              aria-label="Run creation mode"
            >
              <button
                className={mode === "template" ? "active" : ""}
                onClick={() => {
                  setMode("template");
                  setSpec(undefined);
                }}
              >
                Guided template
              </button>
              <button
                className={mode === "json" ? "active" : ""}
                onClick={() => {
                  setMode("json");
                  setSpec(undefined);
                }}
              >
                Advanced JSON
              </button>
            </div>
          )}
          {mode === "template" && selectedTemplate ? (
            <div className="template-builder">
              <label>
                Experiment template
                <select
                  value={templateId}
                  onChange={(event) => selectTemplate(event.target.value)}
                >
                  {templates.map((template) => (
                    <option
                      key={template.templateId}
                      value={template.templateId}
                    >
                      {template.label}
                      {template.recommended ? " · recommended" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <p className="redaction-note template-description">
                {selectedTemplate.description}
              </p>
              <div className="template-fields">
                <label>
                  Run ID
                  <input
                    value={runId}
                    onChange={(event) => {
                      setRunId(event.target.value);
                      setSpec(undefined);
                    }}
                  />
                </label>
                <label>
                  Agent
                  <select
                    value={templateAgent?.variantId ?? ""}
                    onChange={(event) => {
                      setAgentVariantId(event.target.value);
                      setSpec(undefined);
                    }}
                  >
                    {selectedTemplate.spec.agents.map((agent) => (
                      <option key={agent.variantId} value={agent.variantId}>
                        {agent.backendId} · {agent.model.modelId}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Repeats
                  <input
                    type="number"
                    min="1"
                    value={repeats}
                    onChange={(event) => {
                      setRepeats(Number(event.target.value));
                      setSpec(undefined);
                    }}
                  />
                </label>
                <label>
                  Timeout (seconds)
                  <input
                    type="number"
                    min="1"
                    value={timeoutSeconds}
                    onChange={(event) => {
                      setTimeoutSeconds(Number(event.target.value));
                      setSpec(undefined);
                    }}
                  />
                </label>
                <label>
                  Max concurrency
                  <input
                    type="number"
                    min="1"
                    value={maxConcurrency}
                    onChange={(event) => {
                      setMaxConcurrency(Number(event.target.value));
                      setSpec(undefined);
                    }}
                  />
                </label>
                <label>
                  Budget USD (optional)
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={budgetUsd}
                    onChange={(event) => {
                      setBudgetUsd(event.target.value);
                      setSpec(undefined);
                    }}
                  />
                </label>
              </div>
            </div>
          ) : (
            <label>
              Canonical EvaluationRunSpec JSON
              <textarea
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setSpec(undefined);
                }}
                rows={12}
                spellCheck={false}
                placeholder="Paste a canonical protocol-v1 EvaluationRunSpec"
              />
            </label>
          )}
          <div className="dialog-actions">
            <button
              onClick={() => {
                setOpen(false);
                setSpec(undefined);
                setError(undefined);
              }}
            >
              Close
            </button>
            <button
              className="primary"
              disabled={mode === "json" ? !draft.trim() : !selectedTemplate}
              onClick={validate}
            >
              Validate immutable spec
            </button>
          </div>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {spec && (
            <section
              className="spec-preview"
              aria-label="Immutable run specification preview"
            >
              <h3>Submission preview</h3>
              <dl className="definition-list">
                <dt>Run</dt>
                <dd>{spec.runId}</dd>
                <dt>Dataset version</dt>
                <dd>
                  {spec.taskPack.evaluatedSlice.dataset.datasetId} ·{" "}
                  {spec.taskPack.evaluatedSlice.dataset.version}
                </dd>
                <dt>Selection</dt>
                <dd>{spec.taskPack.evaluatedSlice.selectionKind}</dd>
                <dt>Coverage</dt>
                <dd>
                  {spec.taskPack.evaluatedSlice.selectedItems}/
                  {spec.taskPack.evaluatedSlice.dataset.totalItems} ·{" "}
                  {formatPercent(spec.taskPack.evaluatedSlice.coverageRatio)}
                </dd>
                <dt>Task manifest</dt>
                <dd>
                  <code>
                    {spec.taskPack.evaluatedSlice.selectionSpec.taskIdsHash}
                  </code>
                </dd>
                <dt>Slice manifest</dt>
                <dd>
                  <code>{spec.taskPack.evaluatedSlice.sliceManifestHash}</code>
                </dd>
                <dt>Verifier</dt>
                <dd>
                  {spec.verification.verifierId} ·{" "}
                  {spec.verification.verifierVersion}
                </dd>
                <dt>Repeats</dt>
                <dd>{spec.execution.repeats}</dd>
                <dt>Evidence</dt>
                <dd>
                  {spec.verification.officialRequired
                    ? "official required"
                    : "native accepted"}
                </dd>
                <dt>Agents</dt>
                <dd>
                  {spec.agents
                    .map((agent) => agent.backendId + "/" + agent.model.modelId)
                    .join(", ")}
                </dd>
                <dt>Worker readiness</dt>
                <dd>
                  {onlineWorkers.length > 0
                    ? String(onlineWorkers.length) + " compatible online"
                    : compatibleWorkers.length > 0
                      ? "compatible Worker registration is stale"
                      : readinessDiagnostics.length > 0
                        ? "blocked by preflight"
                        : "no compatible Worker registered"}
                </dd>
              </dl>
              <div className="dialog-actions">
                <button disabled={busy} onClick={() => void submit(false)}>
                  Submit resolved run
                </button>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    onlineWorkers.length === 0 ||
                    !capabilities?.commands.includes("run.start")
                  }
                  onClick={() => void submit(true)}
                >
                  Create &amp; start
                </button>
              </div>
              {onlineWorkers.length === 0 && (
                <p className="redaction-note">
                  Create as draft remains available; starting is blocked until a
                  Worker passes this exact sandbox image, network policy, Agent
                  configuration, credential-reference, and benchmark preflight.
                </p>
              )}
              {onlineWorkers.length === 0 && readinessDiagnostics.length > 0 && (
                <ul className="inline-error" aria-label="Worker preflight diagnostics">
                  {[...new Set(readinessDiagnostics)].map((diagnostic) => (
                    <li key={diagnostic}>{diagnostic}</li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </section>
  );
}

function buildTemplateSpec(input: {
  template?: EvaluationRunTemplate;
  runId: string;
  agentVariantId: string;
  repeats: number;
  timeoutSeconds: number;
  maxConcurrency: number;
  budgetUsd: string;
}): unknown {
  if (!input.template) throw new Error("Select a run template");
  const source = structuredClone(input.template.spec);
  const agent = source.agents.find(
    (item) => item.variantId === input.agentVariantId,
  );
  if (!agent) throw new Error("Select an Agent variant");
  const concurrency = Math.max(1, Math.trunc(input.maxConcurrency));
  source.runId = input.runId.trim();
  source.createdAt = new Date().toISOString();
  source.agents = [agent];
  source.execution.repeats = Math.trunc(input.repeats);
  source.execution.timeoutMs = Math.trunc(input.timeoutSeconds * 1_000);
  source.execution.maxConcurrency = concurrency;
  source.execution.maxConcurrencyPerBackend = concurrency;
  source.execution.maxConcurrencyPerProvider = concurrency;
  const artifactAllowlist = new Set(source.sandbox.artifactAllowlist);
  for (const taskId of input.template.builder.taskIds) {
    for (
      let repeatIndex = 0;
      repeatIndex < source.execution.repeats;
      repeatIndex += 1
    ) {
      const trialId = [
        source.runId,
        taskId,
        agent.variantId,
        String(repeatIndex),
      ].join(":");
      for (const template of
        input.template.builder.artifactAllowlistPathTemplates) {
        artifactAllowlist.add(
          renderArtifactPathTemplate(template, {
            taskPackId: source.taskPack.id,
            runId: source.runId,
            taskId,
            agentVariantId: agent.variantId,
            repeatIndex: String(repeatIndex),
            trialId,
          }),
        );
      }
    }
  }
  source.sandbox.artifactAllowlist = [...artifactAllowlist];
  source.execution.budget = input.budgetUsd.trim()
    ? { ...(source.execution.budget ?? {}), maxUsd: Number(input.budgetUsd) }
    : undefined;
  return source;
}

function renderArtifactPathTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{([^{}]+)\}/gu, (_match, name: string) => {
    const value = values[name];
    if (value === undefined)
      throw new Error("Unsupported artifact path placeholder: " + name);
    return value;
  });
}

function freshWebRunId(templateId: string): string {
  const random = new Uint32Array(2);
  globalThis.crypto.getRandomValues(random);
  return (
    "web-" +
    templateId.replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 48) +
    "-" +
    Date.now().toString(36) +
    "-" +
    [...random]
      .map((value) => value.toString(36))
      .join("")
      .slice(0, 10)
  );
}

function workerSupportsSpec(worker: unknown, spec: EvaluationRunSpec): boolean {
  const registration = object(object(worker).registration);
  const sandboxes = Array.isArray(registration.sandboxProviders)
    ? registration.sandboxProviders
    : [];
  const agents = Array.isArray(registration.agentBackends)
    ? registration.agentBackends
    : [];
  const benchmarks = Array.isArray(registration.benchmarkAdapters)
    ? registration.benchmarkAdapters
    : [];
  const capabilitiesMatch = (
    sandboxes.includes(spec.sandbox.provider) &&
    spec.agents.every((agent) => agents.includes(agent.backendId)) &&
    benchmarks.includes(spec.taskPack.id)
  );
  if (!capabilitiesMatch) return false;
  const readiness = object(registration.readiness);
  if (Object.keys(readiness).length === 0) return true;
  const sandboxReady = array(readiness.sandboxes).some((entry) => {
    const value = object(entry);
    return value.provider === spec.sandbox.provider &&
      value.imageDigest === spec.sandbox.imageDigest &&
      value.networkMode === spec.sandbox.network.mode &&
      JSON.stringify(array(value.allowedDestinations)) === JSON.stringify(spec.sandbox.network.allowedDestinations) &&
      value.ok === true;
  });
  if (!sandboxReady) return false;
  return spec.agents.every((agent) =>
    array(readiness.agents).some((entry) => {
      const value = object(entry);
      return value.backendId === agent.backendId && value.configHash === agent.configHash && value.ok === true;
    }),
  );
}

function workerReadinessDiagnostics(worker: unknown, spec: EvaluationRunSpec): string[] {
  const registration = object(object(worker).registration);
  const readiness = object(registration.readiness);
  if (Object.keys(readiness).length === 0) return [];
  const diagnostics: string[] = [];
  for (const entry of array(readiness.sandboxes)) {
    const value = object(entry);
    if (value.provider !== spec.sandbox.provider || value.imageDigest !== spec.sandbox.imageDigest) continue;
    for (const diagnostic of array(value.errors)) diagnostics.push(readinessMessage(diagnostic));
  }
  for (const agent of spec.agents) {
    for (const entry of array(readiness.agents)) {
      const value = object(entry);
      if (value.backendId !== agent.backendId || value.configHash !== agent.configHash) continue;
      for (const diagnostic of array(value.errors)) diagnostics.push(readinessMessage(diagnostic));
    }
  }
  return diagnostics.filter(Boolean);
}

function readinessMessage(value: unknown): string {
  const diagnostic = object(value);
  const code = field(diagnostic, "code");
  const message = field(diagnostic, "message");
  return code && message ? code + ": " + message : message || code;
}

function workerIsOnline(worker: unknown): boolean {
  const heartbeat = Date.parse(field(worker, "heartbeatAt"));
  return Number.isFinite(heartbeat) && Date.now() - heartbeat < 90_000;
}

function RunDetail({
  runId,
  capabilities,
  controlPlane,
  busy,
  execute,
  refreshToken,
}: {
  runId: string;
  capabilities?: ControlPlaneCapabilities;
  controlPlane: DashboardControlPlane;
  busy: boolean;
  execute(command: EvaluationCommand): Promise<boolean>;
  refreshToken: string;
}): JSX.Element {
  const parameters = new URLSearchParams(globalThis.location.search);
  const [run, setRun] = useState<unknown>();
  const [trials, setTrials] = useState<Page>({
    items: [],
    page: { hasMore: false },
  });
  const [artifacts, setArtifacts] = useState<Page>({
    items: [],
    page: { hasMore: false },
  });
  const [events, setEvents] = useState<Page>({
    items: [],
    page: { hasMore: false },
  });
  const [analysisJobs, setAnalysisJobs] = useState<Page>({
    items: [],
    page: { hasMore: false },
  });
  const [traceEvents, setTraceEvents] = useState<unknown[]>([]);
  const [traceState, setTraceState] = useState<
    "idle" | "loading" | "ready" | "unavailable" | "error"
  >("idle");
  const [selectedTrialId, setSelectedTrialId] = useState(
    parameters.get("trialId") ?? "",
  );
  const [filters, setFilters] = useState({
    state: parameters.get("trialState") ?? "",
    agentVariantId: parameters.get("agentVariantId") ?? "",
    taskId: parameters.get("taskId") ?? "",
  });
  const [error, setError] = useState<string>();
  const load = useCallback(
    async (filterValues = filters) => {
      try {
        const query: EvaluationQuery & Record<string, unknown> = {
          resource: "trials",
          runId,
          page: { limit: 100 },
        };
        for (const [key, value] of Object.entries(filterValues))
          if (value.trim()) query[key] = value.trim();
        const [runValue, trialPage, eventPage, jobPage] = await Promise.all([
          controlPlane.query({ resource: "run", runId }),
          controlPlane.query<Page>(query),
          controlPlane.query<Page>({
            resource: "events",
            runId,
            afterSequence: -1,
            page: { limit: 500 },
          }),
          capabilities?.queryResources.includes("analysis-jobs")
            ? controlPlane.query<Page>({
                resource: "analysis-jobs",
                runId,
                page: { limit: 100 },
              })
            : Promise.resolve({
                items: [],
                page: { hasMore: false, total: 0 },
              }),
        ]);
        setRun(runValue);
        setTrials(trialPage);
        setEvents(eventPage);
        setAnalysisJobs(jobPage);
        setError(undefined);
        const available = trialPage.items
          .map((trial) => field(trial, "trialId"))
          .filter(Boolean);
        setSelectedTrialId((current) =>
          available.includes(current) ? current : (available[0] ?? ""),
        );
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [capabilities, controlPlane, filters, runId],
  );
  useEffect(() => {
    void load();
  }, [load, refreshToken]);
  useEffect(() => {
    if (!selectedTrialId) {
      setArtifacts({ items: [], page: { hasMore: false } });
      setTraceEvents([]);
      setTraceState("idle");
      return;
    }
    const controller = new AbortController();
    setTraceState("loading");
    void controlPlane
      .query<Page>(
        {
          resource: "artifacts",
          runId,
          trialId: selectedTrialId,
          page: { limit: 100 },
        },
        controller.signal,
      )
      .then(async (page) => {
        if (controller.signal.aborted) return;
        setArtifacts(page);
        const normalized = page.items.find((artifact) =>
          field(artifact, "path").endsWith("/normalized-events.jsonl"),
        );
        if (!normalized) {
          setTraceEvents([]);
          setTraceState("unavailable");
          return;
        }
        const text = await controlPlane.artifactText(
          field(normalized, "artifactId"),
          selectedTrialId,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const lines = text
          .split(String.fromCharCode(10))
          .map((line) =>
            line.endsWith(String.fromCharCode(13)) ? line.slice(0, -1) : line,
          )
          .filter((line) => line.trim());
        const events = lines.map((line, index) => {
          try {
            return JSON.parse(line);
          } catch {
            throw new Error(
              "Normalized trace line " +
                String(index + 1) +
                " is not valid JSON",
            );
          }
        });
        setTraceEvents(events);
        setTraceState("ready");
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setTraceEvents([]);
          setTraceState("error");
          setError(errorMessage(cause));
        }
      });
    const url = new URL(globalThis.location.href);
    url.searchParams.set("runId", runId);
    url.searchParams.set("trialId", selectedTrialId);
    globalThis.history.replaceState({}, "", url);
    return () => controller.abort();
  }, [controlPlane, runId, selectedTrialId]);
  const applyFilters = () => {
    const url = new URL(globalThis.location.href);
    for (const [key, value] of Object.entries(filters)) {
      const parameter = key === "state" ? "trialState" : key;
      if (value.trim()) url.searchParams.set(parameter, value.trim());
      else url.searchParams.delete(parameter);
    }
    globalThis.history.replaceState({}, "", url);
    void load(filters);
  };
  const retryTrial = async () => {
    if (selectedTrialId)
      await execute({
        ...operatorCommandEnvelope(operatorSession()),
        type: "trial.retry",
        runId,
        trialIds: [selectedTrialId],
      });
  };
  const startRun = async () =>
    await execute({
      ...operatorCommandEnvelope(operatorSession()),
      type: "run.start",
      runId,
    });
  const cancelRun = async () =>
    await execute({
      ...operatorCommandEnvelope(operatorSession()),
      type: "run.cancel",
      runId,
      reason: "cancelled from live run detail",
    });
  const accepted = object(object(run).accepted);
  const spec = object(accepted.spec);
  const evaluatedSlice = object(object(spec.taskPack).evaluatedSlice);
  const dataset = object(evaluatedSlice.dataset);
  const terminalStates = new Set([
    "completed",
    "blocked",
    "timeout",
    "cancelled",
    "agent_error",
    "environment_error",
    "verifier_error",
    "indeterminate",
  ]);
  const completedTrials = trials.items.filter((trial) =>
    terminalStates.has(field(trial, "state")),
  ).length;
  const selectedTrial = trials.items.find(
    (trial) => field(trial, "trialId") === selectedTrialId,
  );
  const runState = field(run, "state");
  return (
    <section
      className="panel run-detail"
      data-selected-run={runId}
      data-selected-trial={selectedTrialId}
    >
      <PanelHeading
        title={"Run detail · " + runId}
        eyebrow="Trials and evidence"
      />
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="spec-band">
        <Metric label="State" value={field(run, "state") || "—"} />
        <Metric
          label="Progress"
          value={
            String(completedTrials) +
            "/" +
            String(trials.page.total ?? trials.items.length)
          }
        />
        <Metric label="Dataset" value={field(dataset, "datasetId") || "—"} />
        <Metric
          label="Selection"
          value={field(evaluatedSlice, "selectionKind") || "—"}
        />
        <Metric
          label="Coverage"
          value={
            typeof evaluatedSlice.selectedItems === "number" &&
            typeof dataset.totalItems === "number"
              ? String(evaluatedSlice.selectedItems) +
                "/" +
                String(dataset.totalItems)
              : "—"
          }
        />
        <Metric
          label="Budget USD"
          value={field(spec, "execution.budget.maxUsd") || "—"}
        />
      </div>
      <div className="filter-bar" aria-label="Trial server filters">
        <label>
          State
          <input
            value={filters.state}
            onChange={(event) =>
              setFilters({ ...filters, state: event.target.value })
            }
          />
        </label>
        <label>
          Agent variant
          <input
            value={filters.agentVariantId}
            onChange={(event) =>
              setFilters({ ...filters, agentVariantId: event.target.value })
            }
          />
        </label>
        <label>
          Task
          <input
            value={filters.taskId}
            onChange={(event) =>
              setFilters({ ...filters, taskId: event.target.value })
            }
          />
        </label>
        <button className="primary" onClick={applyFilters}>
          Apply filters
        </button>
      </div>
      <div className="operator-actions detail-actions">
        <button
          disabled={
            busy ||
            !capabilities?.commands.includes("run.start") ||
            !["draft", "blocked", "interrupted"].includes(runState)
          }
          onClick={() => void startRun()}
        >
          Start run
        </button>
        <button
          disabled={
            busy ||
            !selectedTrialId ||
            !capabilities?.commands.includes("trial.retry")
          }
          onClick={() => void retryTrial()}
        >
          Retry selected trial
        </button>
        <button
          disabled={
            busy ||
            !capabilities?.commands.includes("run.cancel") ||
            ["completed", "failed", "cancelled"].includes(runState)
          }
          onClick={() => void cancelRun()}
        >
          Cancel this run
        </button>
      </div>
      <label className="trial-selector">
        Selected trial
        <select
          value={selectedTrialId}
          onChange={(event) => setSelectedTrialId(event.target.value)}
        >
          {trials.items.map((trial) => (
            <option
              key={field(trial, "trialId")}
              value={field(trial, "trialId")}
            >
              {field(trial, "trialId")} · {field(trial, "state")}
            </option>
          ))}
        </select>
      </label>
      <Rows
        items={trials.items}
        fields={[
          "trialId",
          "taskId",
          "agentVariantId",
          "attempt",
          "state",
          "failure.code",
          "failure.summary",
        ]}
      />
      {selectedTrial !== undefined && (
        <section className="live-result-panel">
          <h3>Selected trial result</h3>
          <div className="spec-band">
            <Metric
              label="State"
              value={field(selectedTrial, "state") || "—"}
            />
            <Metric
              label="Evidence"
              value={field(selectedTrial, "evidence.evidenceLevel") || "—"}
            />
            <Metric
              label="Verifier"
              value={
                field(selectedTrial, "evidence.benchmarkResult.verifierId") ||
                "—"
              }
            />
            <Metric
              label="Result hash"
              value={
                field(selectedTrial, "evidence.resultHash") ||
                field(selectedTrial, "terminalResultHash") ||
                "—"
              }
            />
          </div>
          <dl className="definition-list">
            <dt>Native metrics</dt>
            <dd>
              <code>
                {display(
                  path(selectedTrial, "evidence.benchmarkResult.nativeMetrics"),
                )}
              </code>
            </dd>
            <dt>Artifact manifest</dt>
            <dd>
              <code>
                {field(
                  selectedTrial,
                  "evidence.artifactManifest.manifestHash",
                ) || "—"}
              </code>
            </dd>
            <dt>Failure responsibility</dt>
            <dd>{field(selectedTrial, "failure.responsibility") || "—"}</dd>
            <dt>Failure summary</dt>
            <dd>{field(selectedTrial, "failure.summary") || "—"}</dd>
          </dl>
        </section>
      )}
      <section className="live-timeline">
        <h3>Durable run timeline</h3>
        {events.items.length ? (
          <Rows
            items={events.items}
            fields={[
              "sequence",
              "at",
              "type",
              "trialId",
              "producer",
              "data.state",
              "data.reason",
            ]}
          />
        ) : (
          <p className="redaction-note">No durable events recorded.</p>
        )}
      </section>
      <section className="live-analysis-jobs">
        <h3>Analysis &amp; grading jobs</h3>
        {analysisJobs.items.length ? (
          <Rows
            items={analysisJobs.items}
            fields={[
              "jobId",
              "kind",
              "state",
              "executorId",
              "updatedAt",
              "failure",
            ]}
          />
        ) : (
          <p className="redaction-note">
            No analysis jobs queued for this run.
          </p>
        )}
      </section>
      <section className="trace-panel" data-trace-state={traceState}>
        <h3>Normalized trace</h3>
        <p className="redaction-note">
          The visual sequence strip is paired with the complete
          keyboard-scrollable event table.
        </p>
        {traceState === "loading" ? (
          <p role="status">Loading normalized evidence…</p>
        ) : traceState === "unavailable" ? (
          <p role="status">
            Normalized trace artifact unavailable for this trial.
          </p>
        ) : traceState === "error" ? (
          <p role="alert">Normalized trace could not be loaded.</p>
        ) : traceEvents.length ? (
          <>
            <div className="trace-strip" aria-hidden="true">
              {traceEvents.slice(0, 80).map((event, index) => (
                <i
                  key={field(event, "sequence") || String(index)}
                  title={field(event, "type")}
                />
              ))}
            </div>
            <Rows
              items={traceEvents}
              fields={["sequence", "at", "type", "phase", "data"]}
            />
          </>
        ) : null}
      </section>
      <h3 id="artifacts">Artifacts</h3>
      {artifacts.items.length ? (
        <div className="artifact-links">
          {artifacts.items.map((artifact) => (
            <button
              type="button"
              key={field(artifact, "artifactId")}
              onClick={() => void downloadBlob(
                () => controlPlane.artifactBlob(field(artifact, "artifactId"), selectedTrialId),
                field(artifact, "artifactId"),
              )}
            >
              {field(artifact, "artifactId")}
              <small>
                {field(artifact, "mediaType")} · {field(artifact, "bytes")}{" "}
                bytes · {field(artifact, "redaction")}
              </small>
            </button>
          ))}
        </div>
      ) : (
        <p className="redaction-note">
          No artifact metadata for the selected trial.
        </p>
      )}
    </section>
  );
}

function confirmationText(intent: OperatorIntent): string {
  return intent.action + ":" + intent.runId;
}
function runIdFrom(value: unknown): string {
  return (
    field(value, "accepted.spec.runId") ||
    field(value, "runId") ||
    field(value, "id")
  );
}

function Analysis({
  data,
  capabilities,
  controlPlane,
}: {
  data: unknown;
  capabilities?: ControlPlaneCapabilities;
  controlPlane: DashboardControlPlane;
}): JSX.Element {
  const value = object(data);
  const vectors = pageItems(value.capabilityVectors);
  const archiveView = (
    <ArchiveConclusions
      archive={object(value.archive)}
      controlPlane={controlPlane}
      kinds={["run-result", "finding", "closed-loop"]}
    />
  );
  return (
    <div className="stack">
      {archiveView}
      <section className="stat-band">
        <Metric
          label="Analysis jobs"
          value={String(pageItems(value.jobs).length)}
        />
        <Metric
          label="Findings"
          value={String(pageItems(value.defects).length)}
        />
        <Metric label="Capability vectors" value={String(vectors.length)} />
        <Metric label="Comparability" value="slice-bound" />
      </section>
      <FilterableResourcePanel
        resource={RESOURCES.analysis}
        initial={value.jobs}
        controlPlane={controlPlane}
        eyebrow="Scores, vectors, comparison & traces"
      />
      <section className="panel">
        <PanelHeading
          title="Normalized capability vectors"
          eyebrow="Eleven evidence-linked components"
        />
        <Rows
          items={vectors.flatMap(capabilityRows)}
          fields={[
            "runId",
            "agentVariantId",
            "component",
            "score",
            "methodologyRef",
            "detectorIds",
            "verifierIds",
            "evidenceCount",
          ]}
        />
      </section>
      <section className="split">
        <div className="panel">
          <PanelHeading
            title="Failure taxonomy & divergence"
            eyebrow="First meaningful difference"
          />
          <Rows
            items={pageItems(value.defects)}
            fields={[
              "findingId",
              "category",
              "severity",
              "firstDivergenceSequence",
              "confidence",
            ]}
          />
        </div>
        <div className="panel">
          <PanelHeading
            title="Analysis coverage"
            eyebrow="Authoritative methods"
          />
          <ul className="fact-list">
            <li>Native benchmark scores and normalized capability vectors</li>
            <li>Paired statistics and confidence intervals</li>
            <li>Cost/latency Pareto and post-divergence cost</li>
            <li>Environment/platform health separation</li>
            <li>Evaluated-slice comparability diagnostics</li>
          </ul>
        </div>
      </section>
      <OperatorCommandForm
        title="Queue analysis"
        allowed={[
          "run.grade",
          "run.analyze",
          "run.align",
          "run.cluster",
          "run.counterfactual",
        ]}
        capabilities={capabilities}
        controlPlane={controlPlane}
      />
    </div>
  );
}

function capabilityRows(value: unknown): unknown[] {
  const vector = object(value);
  return Object.entries(object(vector.components)).map(
    ([component, details]) => ({
      runId: field(vector, "runId"),
      agentVariantId: field(vector, "agentVariantId"),
      component,
      score: path(details, "score"),
      methodologyRef: path(details, "methodologyRef"),
      detectorIds: path(details, "detectorIds"),
      verifierIds: path(details, "verifierIds"),
      evidenceCount: Array.isArray(path(details, "evidenceRefs"))
        ? (path(details, "evidenceRefs") as unknown[]).length
        : 0,
    }),
  );
}

function Defects({
  data,
  capabilities,
  controlPlane,
}: {
  data: unknown;
  capabilities?: ControlPlaneCapabilities;
  controlPlane: DashboardControlPlane;
}): JSX.Element {
  const value = object(data);
  return (
    <div className="stack">
      <ArchiveConclusions
        archive={object(value.archive)}
        controlPlane={controlPlane}
        kinds={["finding", "reproduction"]}
      />
      <FilterableResourcePanel
        resource={RESOURCES.defects}
        initial={value.defects}
        controlPlane={controlPlane}
        title="Detector findings & clusters"
        eyebrow="Evidence and first divergence"
      />
      <section className="split">
        <div className="panel">
          <PanelHeading
            title="Verified reproductions"
            eyebrow="Minimized fresh environments"
          />
          <Rows
            items={pageItems(value.reproductions)}
            fields={[
              "bundleId",
              "findingId",
              "failureFingerprint",
              "reproduction.reproduced",
              "reproduction.minimization.minimizedUnits",
            ]}
          />
        </div>
        <div className="panel">
          <PanelHeading
            title="Human taxonomy promotions"
            eyebrow="Annotations and ownership"
          />
          <Rows
            items={pageItems(value.promotions)}
            fields={[
              "promotionId",
              "cluster.clusterId",
              "cluster.humanName",
              "cluster.promotedCategory",
              "promotedBy.actorId",
              "promotedAt",
            ]}
          />
        </div>
      </section>
      <OperatorCommandForm
        title="Promote defect or cluster"
        allowed={["defect.promote", "failure-cluster.promote"]}
        capabilities={capabilities}
        controlPlane={controlPlane}
      />
    </div>
  );
}

function Regression({
  data,
  capabilities,
  controlPlane,
}: {
  data: unknown;
  capabilities?: ControlPlaneCapabilities;
  controlPlane: DashboardControlPlane;
}): JSX.Element {
  const value = object(data);
  return (
    <div className="stack">
      <ArchiveConclusions
        archive={object(value.archive)}
        controlPlane={controlPlane}
        kinds={["regression", "closed-loop"]}
      />
      <section className="panel">
        <PanelHeading
          title="Versioned regression packs"
          eyebrow="Owners, locks, flake policy & promotion source"
        />
        <Rows
          items={pageItems(value.packs)}
          fields={[
            "packId",
            "version",
            "taskPackRef",
            "severity",
            "owner",
            "allowedFlakeRate",
            "promotionSourceFindingId",
          ]}
        />
      </section>
      <section className="panel">
        <PanelHeading
          title="Baseline / candidate release decisions"
          eyebrow="Bootstrap, variance, completeness & Pareto"
        />
        <Rows
          items={pageItems(value.decisions)}
          fields={[
            "gateId",
            "decision",
            "pairedTasks",
            "repeats",
            "flakyTasks",
            "infrastructureFailures",
            "violations",
            "statistics.successRateDelta",
            "statistics.confidenceInterval",
            "statistics.mcnemarPValue",
            "statistics.repeatedRunVariance",
            "statistics.evidenceCompleteness",
            "statistics.pareto.relation",
            "statistics.taskDeltas",
          ]}
        />
      </section>
      <OperatorCommandForm
        title="Evaluate release gate"
        allowed={["regression.evaluate"]}
        capabilities={capabilities}
        controlPlane={controlPlane}
      />
    </div>
  );
}

function Insights({
  data,
  capabilities,
  controlPlane,
}: {
  data: unknown;
  capabilities?: ControlPlaneCapabilities;
  controlPlane: DashboardControlPlane;
}): JSX.Element {
  const value = object(data);
  const items = pageItems(value.live ?? data);
  return (
    <div className="stack">
      <ArchiveConclusions
        archive={object(value.archive)}
        controlPlane={controlPlane}
        kinds={["insight"]}
      />
      <section className="panel">
        <PanelHeading
          title="Evidence-linked product insights"
          eyebrow="Impact through post-fix validation"
        />
        <Rows
          items={items}
          fields={[
            "insightId",
            "failureCluster",
            "affectedTaskRate",
            "severity",
            "suspectedLayer",
            "confidence",
            "recommendation",
            "expectedMetric",
            "regressionPackId",
            "owner",
            "status",
            "evidenceRefs",
            "postFixValidationRefs",
          ]}
        />
      </section>
      <OperatorCommandForm
        title="Record or validate insight"
        allowed={["insight.record"]}
        capabilities={capabilities}
        controlPlane={controlPlane}
      />
    </div>
  );
}

function Reports({
  data,
  capabilities,
  controlPlane,
}: {
  data: unknown;
  capabilities?: ControlPlaneCapabilities;
  controlPlane: DashboardControlPlane;
}): JSX.Element {
  const value = object(data);
  const live = value.live ?? data;
  const items = pageItems(live);
  return (
    <div className="stack">
      <ArchiveConclusions
        archive={object(value.archive)}
        controlPlane={controlPlane}
        kinds={["report", "closed-loop"]}
      />
      <FilterableResourcePanel
        resource={RESOURCES.reports}
        initial={live}
        controlPlane={controlPlane}
        eyebrow="Methodology, provenance & signed manifest"
      />
      <ReportDownloads items={items} controlPlane={controlPlane} />
      <OperatorCommandForm
        title="Generate immutable report"
        allowed={["report.generate"]}
        capabilities={capabilities}
        controlPlane={controlPlane}
      />
    </div>
  );
}

function OperatorCommandForm({
  title,
  allowed,
  capabilities,
  controlPlane,
}: {
  title: string;
  allowed: EvaluationCommand["type"][];
  capabilities?: ControlPlaneCapabilities;
  controlPlane: DashboardControlPlane;
}): JSX.Element {
  const supported = allowed.filter((type) =>
    capabilities?.commands.includes(type),
  );
  const [draft, setDraft] = useState("");
  const [command, setCommand] = useState<EvaluationCommand>();
  const [confirmation, setConfirmation] = useState("");
  const [state, setState] = useState<
    "idle" | "pending" | "committed" | "failed"
  >("idle");
  const [message, setMessage] = useState<string>();
  const validate = () => {
    try {
      const input = object(JSON.parse(draft));
      const parsed = EvaluationCommandSchema.parse({
        ...operatorCommandEnvelope(operatorSession()),
        ...input,
      });
      if (!allowed.includes(parsed.type))
        throw new Error("command type is not valid for this workflow");
      if (!supported.includes(parsed.type))
        throw new Error("Control Plane does not advertise this command");
      setCommand(parsed);
      setConfirmation("");
      setState("idle");
      setMessage(undefined);
    } catch (cause) {
      setCommand(undefined);
      setMessage(errorMessage(cause));
      setState("failed");
    }
  };
  const submit = async () => {
    if (!command || confirmation !== "submit:" + command.type) return;
    setState("pending");
    try {
      const acknowledgement = await controlPlane.command(command);
      setState("committed");
      setMessage(
        "Committed at projection " + String(acknowledgement.projectionVersion),
      );
    } catch (cause) {
      setState("failed");
      setMessage(errorMessage(cause));
    }
  };
  return (
    <section className="panel command-workflow">
      <PanelHeading title={title} eyebrow="Versioned command contract" />
      <p>
        Supported here:{" "}
        {supported.length ? supported.join(", ") : "none advertised"}
      </p>
      <label>
        Command body JSON
        <textarea
          rows={6}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setCommand(undefined);
          }}
          placeholder={'{ "type": "' + allowed[0] + '", … }'}
          spellCheck={false}
        />
      </label>
      <div className="dialog-actions">
        <button disabled={!draft.trim()} onClick={validate}>
          Validate command
        </button>
      </div>
      {command && (
        <div className="command-confirmation">
          <code>
            {command.type} · {command.idempotencyKey}
          </code>
          <label>
            Type <code>{"submit:" + command.type}</code>
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={
              state === "pending" || confirmation !== "submit:" + command.type
            }
            onClick={() => void submit()}
          >
            Submit committed command
          </button>
        </div>
      )}
      {message && (
        <p
          className={state === "failed" ? "inline-error" : "redaction-note"}
          role="status"
        >
          {message}
        </p>
      )}
    </section>
  );
}

function ResourceTable({
  route,
  resource,
  data,
  controlPlane,
}: {
  route: RouteId;
  resource: Resource;
  data: unknown;
  controlPlane: DashboardControlPlane;
}): JSX.Element {
  return (
    <div className="stack">
      <FilterableResourcePanel
        resource={resource}
        initial={data}
        controlPlane={controlPlane}
      />
      {route === "reports" ? (
        <ReportDownloads items={pageItems(data)} controlPlane={controlPlane} />
      ) : null}
    </div>
  );
}

function FilterableResourcePanel({
  resource,
  initial,
  controlPlane,
  title = resource.title,
  eyebrow = "Control Plane authority",
}: {
  resource: Resource;
  initial: unknown;
  controlPlane: DashboardControlPlane;
  title?: string;
  eyebrow?: string;
}): JSX.Element {
  const [result, setResult] = useState(initial);
  const [filters, setFilters] = useState(() =>
    Object.fromEntries(
      (resource.filters ?? []).map((filter) => [
        filter.parameter,
        new URLSearchParams(globalThis.location.search).get(filter.parameter) ??
          "",
      ]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => setResult(initial), [initial]);
  const current = isPage(result)
    ? result
    : { items: [], page: { hasMore: false } };
  const load = async (cursor?: string, append = false) => {
    setBusy(true);
    setError(undefined);
    try {
      const parameters = new URLSearchParams();
      for (const [key, value] of Object.entries(filters))
        if (value.trim()) parameters.set(key, value.trim());
      const loaded = await controlPlane.query<Page>(
        queryForResource(resource, parameters, cursor),
      );
      setResult(
        append
          ? { items: [...current.items, ...loaded.items], page: loaded.page }
          : loaded,
      );
      const url = new URL(globalThis.location.href);
      for (const filter of resource.filters ?? []) {
        const value = filters[filter.parameter]?.trim();
        if (value) url.searchParams.set(filter.parameter, value);
        else url.searchParams.delete(filter.parameter);
      }
      globalThis.history.replaceState({}, "", url);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack filterable-resource">
      {resource.filters?.length ? (
        <section
          className="filter-bar"
          aria-label={resource.title + " server filters"}
        >
          {resource.filters.map((filter) => (
            <label key={filter.parameter}>
              {filter.label}
              {filter.values ? (
                <select
                  value={filters[filter.parameter]}
                  onChange={(event) =>
                    setFilters({
                      ...filters,
                      [filter.parameter]: event.target.value,
                    })
                  }
                >
                  <option value="">All</option>
                  {filter.values.map((value) => (
                    <option key={value} value={value}>
                      {value.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={filters[filter.parameter]}
                  onChange={(event) =>
                    setFilters({
                      ...filters,
                      [filter.parameter]: event.target.value,
                    })
                  }
                />
              )}
            </label>
          ))}
          <button
            className="primary"
            disabled={busy}
            onClick={() => void load()}
          >
            Apply filters
          </button>
        </section>
      ) : null}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <section className="panel">
        <PanelHeading title={title} eyebrow={eyebrow} />
        {current.items.length ? (
          <Rows items={current.items} fields={resource.columns} />
        ) : (
          <EmptyScene
            title={"No " + resource.title.toLowerCase()}
            detail="This is a truthful empty state from the durable projection."
          />
        )}
        {current.page.hasMore && (
          <div className="pagination-bar">
            <span>
              {current.items.length} of {current.page.total ?? "more"}{" "}
              authoritative records
            </span>
            <button
              disabled={busy || !current.page.nextCursor}
              onClick={() => void load(current.page.nextCursor, true)}
            >
              Load next page
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function ReportDownloads({
  items,
  controlPlane,
}: {
  items: unknown[];
  controlPlane: DashboardControlPlane;
}): JSX.Element | null {
  const reportId = items
    .map((item) => field(item, "reportId") || field(item, "id"))
    .find(Boolean);
  if (!reportId) return null;
  return (
    <section className="panel">
      <PanelHeading
        title="Local exports"
        eyebrow="Hash-bound report artifacts"
      />
      <div className="download-grid">
        {["html", "pdf", "json", "csv", "junit", "sarif", "markdown"].map(
          (format) => (
            <button
              type="button"
              key={format}
              onClick={() => void downloadBlob(
                () => controlPlane.reportBlob(reportId, format),
                reportId + "." + format,
              )}
            >
              {format.toUpperCase()}
            </button>
          ),
        )}
      </div>
      <p className="redaction-note">
        Local-only download · manifest integrity and redaction status remain
        authoritative.
      </p>
    </section>
  );
}

async function downloadBlob(load: () => Promise<Blob>, filename: string): Promise<void> {
  const url = URL.createObjectURL(await load());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function Skeleton(): JSX.Element {
  return (
    <div className="skeleton-grid" aria-label="Loading">
      <div />
      <div />
      <div />
      <div />
    </div>
  );
}
function stateLabel(state: LoadState, locale: Locale): string {
  return translate(locale, ("state." + state) as MessageKey);
}
function capabilityFor(route: RouteId): string | undefined {
  if (route === "overview") return "runs";
  if (route === "library") return "catalog";
  if (route === "leaderboard") return "leaderboard";
  if (route === "administration") return "audit";
  return RESOURCES[route].capability;
}
function leaderboardControls(): LeaderboardControls {
  const parameters = new URLSearchParams(globalThis.location.search);
  const requestedPivot = parameters.get("pivot");
  const pivot =
    requestedPivot === "agent_type" || requestedPivot === "test_dataset"
      ? requestedPivot
      : "model";
  const requestedAgent = parameters.get("agentType");
  const agentType =
    requestedAgent === "agent-runlab" ||
    requestedAgent === "claude-code" ||
    requestedAgent === "codex"
      ? requestedAgent
      : "";
  const requestedSort = parameters.get("sortBy");
  const sortBy =
    requestedSort === "cost" ||
    requestedSort === "p50_duration" ||
    requestedSort === "p95_duration" ||
    requestedSort === "published_at"
      ? requestedSort
      : "primary_metric";
  return {
    pivot,
    sliceManifestHash:
      parameters.get("sliceManifestHash")?.trim().toLowerCase() ?? "",
    view: parameters.get("view") === "audit" ? "audit" : "active",
    agentType,
    modelId: parameters.get("modelId") ?? "",
    sortBy,
    sortDirection: parameters.get("sortDirection") === "asc" ? "asc" : "desc",
  };
}
function leaderboardQuery(
  values: LeaderboardControls,
  sliceManifestHash: string,
): EvaluationQuery {
  return {
    resource: "leaderboard",
    pivot: values.pivot,
    sliceManifestHash,
    view: values.view,
    ...(values.agentType ? { agentType: values.agentType } : {}),
    ...(values.modelId.trim() ? { modelId: values.modelId.trim() } : {}),
    sortBy: values.sortBy,
    sortDirection: values.sortDirection,
    page: { limit: 100 },
  };
}
function writeLeaderboardControls(url: URL, values: LeaderboardControls): void {
  url.searchParams.set("pivot", values.pivot);
  url.searchParams.set("sliceManifestHash", values.sliceManifestHash);
  url.searchParams.set("view", values.view);
  url.searchParams.set("sortBy", values.sortBy);
  url.searchParams.set("sortDirection", values.sortDirection);
  if (values.agentType) url.searchParams.set("agentType", values.agentType);
  else url.searchParams.delete("agentType");
  if (values.modelId.trim())
    url.searchParams.set("modelId", values.modelId.trim());
  else url.searchParams.delete("modelId");
}
function queryForResource(
  resource: Resource,
  parameters: URLSearchParams,
  cursor?: string,
): EvaluationQuery {
  const query = structuredClone(resource.query) as EvaluationQuery &
    Record<string, unknown>;
  query.page = { limit: 100, ...(cursor ? { cursor } : {}) };
  for (const filter of resource.filters ?? []) {
    const value = parameters.get(filter.parameter)?.trim();
    if (value) query[filter.parameter] = value;
  }
  return query;
}
function leaderboardSlice(
  value: unknown,
): LeaderboardEntry["evaluatedSlice"] | undefined {
  const entry = object(value);
  const slice = object(entry.evaluatedSlice);
  const dataset = object(slice.dataset);
  if (
    typeof slice.sliceManifestHash !== "string" ||
    typeof slice.selectedItems !== "number" ||
    typeof slice.coverageRatio !== "number" ||
    typeof dataset.totalItems !== "number"
  )
    return undefined;
  return slice as LeaderboardEntry["evaluatedSlice"];
}
function formatPercent(ratio: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(ratio);
}
function percent(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? formatPercent(value)
    : "—";
}
function classifyLoadedState(
  value: unknown,
): Extract<LoadState, "ready" | "empty" | "partial"> {
  const pages = collectPages(value);
  if (pages.some((page) => page.page.hasMore)) return "partial";
  if (
    pages.length > 0 &&
    pages.every((page) => page.items.length === 0) &&
    !hasStandaloneContent(value)
  )
    return "empty";
  return "ready";
}
function hasStandaloneContent(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    (typeof record.documentCount === "number" && record.documentCount > 0) ||
    (typeof record.runCount === "number" && record.runCount > 0) ||
    (typeof record.trialCount === "number" && record.trialCount > 0) ||
    (Array.isArray(record.conclusions) && record.conclusions.length > 0)
  )
    return true;
  return Object.values(record).some(
    (entry) => !isPage(entry) && hasStandaloneContent(entry),
  );
}
function collectPages(value: unknown): Page[] {
  if (isPage(value)) return [value];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.values(value as Record<string, unknown>).flatMap(collectPages);
}
function isPage(value: unknown): value is Page {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as Page).items) &&
    !!(value as Page).page
  );
}
function pageItems(value: unknown): unknown[] {
  return isPage(value) ? value.items : [];
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function path(value: unknown, name: string): unknown {
  return name
    .split(".")
    .reduce<unknown>((current, key) => object(current)[key], value);
}
function field(value: unknown, name: string): string {
  const found = path(value, name);
  return found === undefined || found === null ? "" : String(found);
}
function display(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
function liveRunsFrom(
  route: RouteId,
  value: unknown,
): Array<{ runId: string; sequence: number }> {
  if (route !== "overview" && route !== "runs") return [];
  const source =
    route === "overview"
      ? object(value).runs
      : (object(value).live ?? value);
  const liveRuns: Array<{ runId: string; sequence: number }> = [];
  for (const candidate of pageItems(source)) {
    const run = object(candidate);
    if (["completed", "failed", "cancelled"].includes(String(run.state)))
      continue;
    const runId = field(run, "accepted.spec.runId") || field(run, "runId");
    if (!runId) continue;
    const events = Array.isArray(run.events) ? run.events : [];
    const sequence = events.reduce((latest, event) => {
      const value = object(event).sequence;
      return typeof value === "number" && Number.isInteger(value)
        ? Math.max(latest, value)
        : latest;
    }, -1);
    liveRuns.push({ runId, sequence });
  }
  return liveRuns;
}
