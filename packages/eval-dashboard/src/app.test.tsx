import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  sha256Hex,
  type ControlPlaneCapabilities,
  type EvaluationRunSpec,
} from "@agent-kernel/eval-protocol";
import canonicalRunSpec from "../../eval-protocol/fixtures/canonical-run-spec-v1.json";
import { App, DashboardErrorBoundary } from "./app.js";
import { DashboardControlPlane } from "./client.js";
import {
  operatorCommandEnvelope,
  operatorSession,
  saveOperatorCommand,
} from "./operator-session.js";
import { ROUTES, routeFromPath } from "./routes.js";

const capabilities: ControlPlaneCapabilities = {
  schemaVersion: 1 as const,
  protocolVersions: [1],
  controlPlaneVersion: "1.0.0",
  commands: [],
  queryResources: [
    "capabilities",
    "platform-metrics",
    "runs",
    "catalog",
    "leaderboard",
    "analysis-jobs",
    "capability-vectors",
    "defects",
    "regressions",
    "insights",
    "reports",
    "audit",
    "workers",
  ],
  liveEvents: "sse",
  standalone: true,
  cleanCutover: true,
  deprecatedCompatibilitySurfaces: [],
};
const operatorCapabilities = {
  ...capabilities,
  commands: ["run.cancel", "leaderboard.publish", "run.delete"],
  queryResources: [...capabilities.queryResources, "deletion-impact"],
};
const workflowCapabilities = {
  ...capabilities,
  commands: [
    "run.create",
    "run.start",
    "trial.retry",
    "run.analyze",
    "leaderboard.invalidate",
  ],
};
const impactHash = "a".repeat(64);
function BrokenView(): JSX.Element {
  throw new Error("sensitive fixture detail");
}

function client(
  options: {
    fail?: boolean;
    empty?: boolean;
    partial?: boolean;
    impact?: {
      impactHash: string;
      derivedResourceIds: string[];
      blockedByRefs: string[];
    };
  } = {},
) {
  return {
    connect: vi.fn(async () => capabilities),
    query: vi.fn(async (query: { resource: string }) => {
      if (options.fail) throw new Error("fixture unavailable");
      if (query.resource === "deletion-impact")
        return (
          options.impact ?? {
            impactHash,
            derivedResourceIds: ["report-one"],
            blockedByRefs: [],
          }
        );
      if (query.resource === "platform-metrics")
        return {
          queue: { queuedTrials: 1, oldestAgeMs: 25 },
          workers: { registered: 1, utilization: 0.5 },
          environmentPreparation: { p95Ms: 10 },
          firstModelCall: { p95Ms: 20 },
          toolCalls: { p95Ms: 30 },
          artifacts: { uploadFailures: 0 },
          grader: { failureRate: 0 },
          orchestrator: { lastRecoveryMs: 4 },
          usage: { inputTokens: 8, outputTokens: 5, costUsd: 0.02 },
          flakes: { taskRate: 0 },
          traceCoverage: { trialsWithTrace: 1, completedTrials: 1 },
          slos: [
            {
              id: "restart-durability",
              status: "meeting",
              target: "durable",
              observed: "replayed",
              evidenceRefs: [],
            },
          ],
        };
      const items: unknown[] = options.empty
        ? []
        : query.resource === "runs"
          ? [
              {
                accepted: { spec: { runId: "run-one" } },
                state: "running",
                updatedAt: "now",
              },
            ]
          : query.resource === "capability-vectors"
            ? [
                {
                  runId: "run-one",
                  agentVariantId: "codex-one",
                  components: {
                    taskSuccess: {
                      score: 1,
                      methodologyRef:
                        "methodology://1.0.0/capability/taskSuccess",
                      detectorIds: [],
                      verifierIds: ["verifier-one"],
                      evidenceRefs: ["evidence-one"],
                    },
                  },
                },
              ]
            : [];
      return {
        items,
        page: {
          hasMore: options.partial ?? false,
          ...(options.partial ? { nextCursor: "1" } : {}),
          total: items.length + (options.partial ? 1 : 0),
        },
      };
    }),
    command: vi.fn(),
    administrationStatus: vi.fn<() => Promise<unknown>>(async () => ({ security: { principals: [], serviceKeys: [], trustKeys: [] }, maintenance: { retentionSweeps: [], backups: [], restoreDrills: [], audit: [] } })),
    reloadSecurity: vi.fn<(confirmation: string) => Promise<unknown>>(async () => ({ generation: 2 })),
    subscribeRunEvents: vi.fn((_subscription: unknown) => () => undefined),
    artifactUrl: vi.fn(
      (artifactId: string, trialId: string) =>
        "http://localhost/artifacts/" + artifactId + "?trialId=" + trialId,
    ),
    artifactText: vi.fn(async () => ""),
    reportUrl: vi.fn(
      (reportId: string, format: string) =>
        "http://localhost/reports/" + reportId + "/" + format,
    ),
  };
}

describe("standalone evaluation dashboard", () => {
  beforeEach(() => {
    history.replaceState({}, "", "/");
    localStorage.clear();
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("defines all ten production routes and resolves unknown URLs safely", () => {
    expect(ROUTES.map((route) => route.label)).toEqual([
      "Overview",
      "Test Library",
      "Runs",
      "Leaderboard",
      "Analysis",
      "Defects",
      "Regression",
      "Insights",
      "Reports",
      "Administration",
    ]);
    expect(routeFromPath("/unknown").id).toBe("overview");
  });

  it("renders read-only administration metadata and requires exact reload confirmation", async () => {
    history.replaceState({}, "", "/administration");
    const controlPlane = client();
    controlPlane.administrationStatus.mockResolvedValue({ security: { principals: [{ principalId: "operator-one", kind: "user", role: "operator", scopes: ["admin"], keyCount: 1 }], serviceKeys: [], trustKeys: [{ keyReference: "trust-one", algorithm: "ed25519", status: "revoked" }] }, maintenance: { retentionSweeps: [{ policyId: "policy-one", dryRun: true, evaluatedAt: "2026-08-03T00:00:00.000Z", candidates: [] }], backups: [{ backupId: "backup-one" }], restoreDrills: [{ backupId: "backup-one", rtoMet: true }], audit: [] } });
    render(<App controlPlane={controlPlane as never} />);
    expect(await screen.findByText("Auth principals & service keys")).toBeTruthy();
    expect(screen.getByText("operator-one")).toBeTruthy();
    expect(screen.getByText("Retention sweep status")).toBeTruthy();
    const action = screen.getByRole("button", { name: "Reload security registry" }) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Security reload confirmation"), { target: { value: "reload-security-registry" } });
    expect(action.disabled).toBe(false);
    fireEvent.click(action);
    await waitFor(() => expect(controlPlane.reloadSecurity).toHaveBeenCalledWith("reload-security-registry"));
  });

  it("contains render failures without exposing error detail or mutating durable state", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    render(
      <DashboardErrorBoundary>
        <BrokenView />
      </DashboardErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Durable Control Plane state was not changed",
    );
    expect(screen.getByRole("alert").textContent).not.toContain(
      "sensitive fixture detail",
    );
    expect(
      screen.getByRole("button", { name: "Reload authoritative UI" }),
    ).toBeTruthy();
    consoleError.mockRestore();
  });

  it("navigates with URL-addressable controls and renders authoritative state", async () => {
    const controlPlane = client();
    render(<App controlPlane={controlPlane as never} />);
    expect(
      await screen.findByText("One durable authority for every Agent trial."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Runs/ }));
    await waitFor(() => expect(location.pathname).toBe("/runs"));
    expect(await screen.findByText("Evaluation runs")).toBeTruthy();
    expect(controlPlane.query).toHaveBeenCalledWith(
      expect.objectContaining({ resource: "runs" }),
      expect.any(AbortSignal),
    );
  });

  it("labels official and compatible local benchmark sources without ambiguity", async () => {
    history.replaceState({}, "", "/library");
    render(<App controlPlane={client() as never} />);
    expect(await screen.findByText("Benchmark provenance")).toBeTruthy();
    expect(screen.getByText(/SWE-Bench is a local run of the pinned official harness/)).toBeTruthy();
    expect(screen.getByText(/non-official compatible\/local task packs/)).toBeTruthy();
  });

  it("keeps the production default Control Plane stable across state updates", async () => {
    const connect = vi
      .spyOn(DashboardControlPlane.prototype, "connect")
      .mockResolvedValue(capabilities);
    const query = vi
      .spyOn(DashboardControlPlane.prototype, "query")
      .mockResolvedValue({
        items: [
          {
            accepted: { spec: { runId: "fresh-default-run" } },
            state: "draft",
            updatedAt: "now",
          },
        ],
        page: { hasMore: false, total: 1 },
      });
    vi.spyOn(
      DashboardControlPlane.prototype,
      "subscribeRunEvents",
    ).mockReturnValue(() => undefined);
    const view = render(<App />);
    expect(await screen.findByText("fresh-default-run")).toBeTruthy();
    view.rerender(<App />);
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(query).toHaveBeenCalledTimes(5);
  });

  it("renders truthful empty, partial, error, and capability-unavailable states", async () => {
    const empty = render(
      <App controlPlane={client({ empty: true }) as never} />,
    );
    expect(await screen.findByText("No standalone runs yet")).toBeTruthy();
    empty.unmount();
    const partial = render(
      <App controlPlane={client({ partial: true }) as never} />,
    );
    expect(await screen.findByText("Partial data")).toBeTruthy();
    partial.unmount();
    const failed = render(
      <App controlPlane={client({ fail: true }) as never} />,
    );
    expect(await screen.findByText("Error")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    failed.unmount();
    const unavailable = client();
    unavailable.connect.mockResolvedValue({
      ...capabilities,
      queryResources: capabilities.queryResources.filter(
        (resource) => resource !== "runs",
      ),
    });
    render(<App controlPlane={unavailable as never} />);
    expect(
      (await screen.findAllByText("Capability unavailable")).length,
    ).toBeGreaterThan(0);
  });

  it("classifies protocol negotiation refusal as unsupported rather than a generic error", async () => {
    const unsupported = client();
    unsupported.connect.mockRejectedValue(
      new Error("Unsupported Control Plane protocol. Dashboard supports v1."),
    );
    render(<App controlPlane={unsupported as never} />);
    expect(
      (await screen.findAllByText("Capability unavailable")).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Error")).toBeNull();
  });

  it("retains the last authoritative projection as explicitly stale when refresh fails", async () => {
    const controlPlane = client();
    render(<App controlPlane={controlPlane as never} />);
    expect(await screen.findByText("run-one")).toBeTruthy();
    controlPlane.query.mockRejectedValueOnce(new Error("refresh unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect((await screen.findAllByText("Stale data")).length).toBe(2);
    expect(screen.getByText("run-one")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("treats live events as notifications and reloads the authoritative projection", async () => {
    const controlPlane = client();
    controlPlane.query.mockResolvedValue({
      items: [
        {
          accepted: { spec: { runId: "run-live" } },
          state: "running",
          events: [{ sequence: 2 }],
        },
      ],
      page: { hasMore: false, total: 1 },
    });
    render(<App controlPlane={controlPlane as never} />);
    await waitFor(() =>
      expect(controlPlane.subscribeRunEvents).toHaveBeenCalledTimes(1),
    );
    const subscription = controlPlane.subscribeRunEvents.mock.calls[0]![0] as {
      runId: string;
      afterSequence: number;
      onEvent(event: { sequence: number }): void;
    };
    expect(subscription).toMatchObject({ runId: "run-live", afterSequence: 2 });
    const queriesBeforeNotification = controlPlane.query.mock.calls.length;
    subscription.onEvent({ sequence: 3 });
    await waitFor(() =>
      expect(controlPlane.query.mock.calls.length).toBeGreaterThan(
        queriesBeforeNotification,
      ),
    );
  });

  it("subscribes to live runs when the Runs route also contains archive and creation resources", async () => {
    history.replaceState({}, "", "/runs");
    const controlPlane = client();
    controlPlane.query.mockImplementation((async (query: { resource: string }) => {
      if (query.resource === "runs")
        return {
          items: [
            {
              accepted: { spec: { runId: "wrapped-live-run" } },
              state: "running",
              events: [{ sequence: 4 }],
            },
          ],
          page: { hasMore: false, total: 1 },
        };
      return { items: [], page: { hasMore: false, total: 0 } };
    }) as never);
    render(<App controlPlane={controlPlane as never} />);
    await waitFor(() =>
      expect(controlPlane.subscribeRunEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "wrapped-live-run",
          afterSequence: 4,
        }),
      ),
    );
  });

  it("keeps archive-backed conclusions ready when the corresponding live page is empty", async () => {
    history.replaceState({}, "", "/defects");
    const controlPlane = client();
    controlPlane.connect.mockResolvedValue({
      ...capabilities,
      queryResources: [...capabilities.queryResources, "archive-summary"],
    });
    controlPlane.query.mockImplementation((async (query: { resource: string }) => {
      if (query.resource === "archive-summary")
        return {
          documentCount: 1,
          runCount: 1,
          trialCount: 1,
          conclusions: [
            {
              conclusionId: "archive-finding",
              kind: "finding",
              status: "human_validated",
              title: "Archived defect conclusion",
              summary: "Evidence-backed finding.",
              runIds: ["archive-run"],
              evidenceRefs: ["archive.json"],
            },
          ],
        };
      return { items: [], page: { hasMore: false, total: 0 } };
    }) as never);
    render(<App controlPlane={controlPlane as never} />);
    expect(await screen.findByText("Archived defect conclusion")).toBeTruthy();
    expect(document.querySelector("main")?.getAttribute("data-load-state")).toBe(
      "ready",
    );
    expect(screen.queryByText("Empty")).toBeNull();
  });

  it("keeps one local operator session across a Runs page remount", async () => {
    history.replaceState({}, "", "/runs");
    const first = render(<App controlPlane={client() as never} />);
    const initialSession = (await screen.findByText(/operator-/)).textContent;
    first.unmount();
    render(<App controlPlane={client() as never} />);
    expect((await screen.findByText(/operator-/)).textContent).toBe(
      initialSession,
    );
  });

  it("restores and safely resumes an interrupted pending command with the same envelope", async () => {
    history.replaceState({}, "", "/runs");
    const session = operatorSession();
    const command = {
      ...operatorCommandEnvelope(session),
      type: "leaderboard.publish" as const,
      runId: "run-one",
    };
    saveOperatorCommand({
      schemaVersion: 1,
      sessionId: session.sessionId,
      command,
      state: "pending",
      updatedAt: "2026-08-03T00:00:00.000Z",
    });
    const controlPlane = client();
    controlPlane.connect.mockResolvedValue(operatorCapabilities);
    controlPlane.command.mockResolvedValue({
      schemaVersion: 1,
      idempotencyKey: command.idempotencyKey,
      commandId: command.commandId,
      committedSequence: 1,
      committedAt: "2026-08-03T00:00:00.000Z",
      projectionVersion: 1,
    });

    render(<App controlPlane={controlPlane as never} />);
    expect(await screen.findByText("Submitting")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Resume same command" }),
    );
    await waitFor(() =>
      expect(controlPlane.command).toHaveBeenCalledWith(command),
    );
    expect(await screen.findByText("Committed")).toBeTruthy();
  });

  it("never submits cancel or publish until the exact confirmation is entered", async () => {
    history.replaceState({}, "", "/runs");
    const controlPlane = client();
    controlPlane.connect.mockResolvedValue(operatorCapabilities);
    render(<App controlPlane={controlPlane as never} />);
    await screen.findByRole("button", { name: "Cancel run" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    const cancel = (await screen.findByRole("button", {
      name: "Confirm cancel",
    })) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type cancel:run-one/), {
      target: { value: "cancel:wrong-run" },
    });
    expect(cancel.disabled).toBe(true);
    expect(controlPlane.command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    fireEvent.click(screen.getByRole("button", { name: "Publish run" }));
    const publish = (await screen.findByRole("button", {
      name: "Confirm publish",
    })) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type publish:run-one/), {
      target: { value: "publish:run-one-extra" },
    });
    expect(publish.disabled).toBe(true);
    expect(controlPlane.command).not.toHaveBeenCalled();
  });

  it("queries authoritative deletion impact and binds its hash to the delete command", async () => {
    history.replaceState({}, "", "/runs");
    const controlPlane = client({
      impact: {
        impactHash,
        derivedResourceIds: ["report-one", "analysis-one"],
        blockedByRefs: [],
      },
    });
    controlPlane.connect.mockResolvedValue(operatorCapabilities);
    controlPlane.command.mockResolvedValue({
      schemaVersion: 1,
      idempotencyKey: "ack",
      commandId: "ack",
      committedSequence: 1,
      committedAt: "2026-08-03T00:00:00.000Z",
      projectionVersion: 1,
    });
    render(<App controlPlane={controlPlane as never} />);
    await screen.findByRole("button", { name: "Delete run" });

    fireEvent.click(screen.getByRole("button", { name: "Delete run" }));
    expect(await screen.findByText(impactHash)).toBeTruthy();
    expect(controlPlane.query).toHaveBeenCalledWith({
      resource: "deletion-impact",
      runId: "run-one",
    });
    expect(controlPlane.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Type delete:run-one/), {
      target: { value: "delete:run-one" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() =>
      expect(controlPlane.command).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "run.delete",
          runId: "run-one",
          expectedImpactHash: impactHash,
          confirmation: "delete:run-one",
        }),
      ),
    );
    expect(await screen.findByText("Committed")).toBeTruthy();
  });

  it("blocks deletion when the authoritative impact contains protected references", async () => {
    history.replaceState({}, "", "/runs");
    const controlPlane = client({
      impact: {
        impactHash,
        derivedResourceIds: [],
        blockedByRefs: ["release-baseline"],
      },
    });
    controlPlane.connect.mockResolvedValue(operatorCapabilities);
    render(<App controlPlane={controlPlane as never} />);
    await screen.findByRole("button", { name: "Delete run" });

    fireEvent.click(screen.getByRole("button", { name: "Delete run" }));
    expect(await screen.findByText("release-baseline")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Type delete:run-one/), {
      target: { value: "delete:run-one" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Confirm delete",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(controlPlane.command).not.toHaveBeenCalled();
  });

  it("retries a failed command with the original idempotency key and refreshes after commit", async () => {
    history.replaceState({}, "", "/runs");
    const controlPlane = client();
    controlPlane.connect.mockResolvedValue(operatorCapabilities);
    controlPlane.command
      .mockRejectedValueOnce(new Error("lost acknowledgement"))
      .mockImplementationOnce(
        async (command: { idempotencyKey: string; commandId: string }) => ({
          schemaVersion: 1,
          idempotencyKey: command.idempotencyKey,
          commandId: command.commandId,
          committedSequence: 2,
          committedAt: "2026-08-03T00:00:00.000Z",
          projectionVersion: 2,
        }),
      );
    render(<App controlPlane={controlPlane as never} />);
    await screen.findByRole("button", { name: "Cancel run" });
    const queriesBefore = controlPlane.query.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    fireEvent.change(await screen.findByLabelText(/Type cancel:run-one/), {
      target: { value: "cancel:run-one" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancel" }));
    expect(await screen.findByText("Command failed")).toBeTruthy();
    const original = controlPlane.command.mock.calls[0]![0];
    fireEvent.click(screen.getByRole("button", { name: "Retry same command" }));

    await waitFor(() => expect(controlPlane.command).toHaveBeenCalledTimes(2));
    expect(controlPlane.command.mock.calls[1]![0]).toEqual(original);
    expect(await screen.findByText("Committed")).toBeTruthy();
    await waitFor(() =>
      expect(controlPlane.query.mock.calls.length).toBeGreaterThan(
        queriesBefore,
      ),
    );
  });

  it("submits run.create only after the complete canonical spec validates and renders immutable provenance", async () => {
    history.replaceState({}, "", "/runs");
    const controlPlane = client();
    controlPlane.connect.mockResolvedValue(workflowCapabilities);
    controlPlane.command.mockImplementation(
      async (command: { idempotencyKey: string; commandId: string }) => ({
        schemaVersion: 1,
        idempotencyKey: command.idempotencyKey,
        commandId: command.commandId,
        committedSequence: 1,
        committedAt: "2026-08-03T00:00:00.000Z",
        projectionVersion: 1,
      }),
    );
    render(<App controlPlane={controlPlane as never} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "New run specification" }),
    );
    const editor = screen.getByLabelText("Canonical EvaluationRunSpec JSON");
    fireEvent.change(editor, {
      target: { value: '{"schemaVersion":1,"runId":"name-only"}' },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Validate immutable spec" }),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Submit resolved run" }),
    ).toBeNull();
    expect(controlPlane.command).not.toHaveBeenCalled();

    fireEvent.change(editor, {
      target: { value: JSON.stringify(canonicalRunSpec) },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Validate immutable spec" }),
    );
    const preview = await screen.findByLabelText(
      "Immutable run specification preview",
    );
    expect(preview.textContent).toContain("swe-bench-verified · 1");
    expect(preview.textContent).toContain("named_subset");
    expect(preview.textContent).toContain("2/500 · 0.4%");
    expect(preview.textContent).toContain("swe-bench-official · 1");
    expect(controlPlane.command).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Submit resolved run" }),
    );
    await waitFor(() =>
      expect(controlPlane.command).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "run.create",
          spec: expect.objectContaining({ runId: "canonical-fixture-v1" }),
        }),
      ),
    );
  });

  it("creates and starts a guided template only when a compatible online Worker advertises every runtime capability", async () => {
    history.replaceState({}, "", "/runs");
    const controlPlane = client();
    const templateSpec = structuredClone(canonicalRunSpec) as EvaluationRunSpec;
    templateSpec.runId = "template-run";
    templateSpec.taskPack.id = "custom-task-pack";
    templateSpec.agents[0].backendId = "custom-command";
    templateSpec.agents[0].variantId = "guided-agent";
    templateSpec.agents[0].credentialRefs = [];
    templateSpec.agents[0].config = { argv: ["true"] };
    templateSpec.agents[0].configHash = await sha256Hex(
      canonicalJson(templateSpec.agents[0].config),
    );
    templateSpec.execution.repeats = 2;
    templateSpec.execution.timeoutMs = 30_000;
    templateSpec.execution.maxConcurrency = 1;
    templateSpec.execution.maxConcurrencyPerBackend = 1;
    templateSpec.execution.maxConcurrencyPerProvider = 1;
    templateSpec.execution.budget = { maxUsd: 2.5 };
    templateSpec.verification.officialRequired = false;
    controlPlane.connect.mockResolvedValue({
      ...workflowCapabilities,
      queryResources: [
        ...workflowCapabilities.queryResources,
        "run-templates",
        "workers",
      ],
    });
    controlPlane.query.mockImplementation((async (
      query: Record<string, unknown>,
    ) => {
      if (query.resource === "runs")
        return { items: [], page: { hasMore: false, total: 0 } };
      if (query.resource === "run-templates")
        return {
          items: [
            {
              schemaVersion: 1,
              templateId: "guided-smoke",
              label: "Guided smoke",
              description: "Deterministic guided run.",
              kind: "smoke",
              recommended: true,
              builder: {
                taskIds: ["task-one", "task-two"],
                artifactAllowlistPathTemplates: [
                  "{taskPackId}/{trialId}/native-result.json",
                ],
              },
              spec: templateSpec,
            },
          ],
          page: { hasMore: false, total: 1 },
        };
      if (query.resource === "workers")
        return {
          items: [
            {
              registration: {
                sandboxProviders: ["docker"],
                agentBackends: ["custom-command"],
                benchmarkAdapters: ["custom-task-pack"],
              },
              heartbeatAt: new Date().toISOString(),
            },
          ],
          page: { hasMore: false, total: 1 },
        };
      return { items: [], page: { hasMore: false, total: 0 } };
    }) as never);
    controlPlane.command.mockImplementation(
      async (command: { idempotencyKey: string; commandId: string }) => ({
        schemaVersion: 1,
        idempotencyKey: command.idempotencyKey,
        commandId: command.commandId,
        committedSequence: 1,
        committedAt: new Date().toISOString(),
        projectionVersion: 1,
      }),
    );
    render(<App controlPlane={controlPlane as never} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "New run specification" }),
    );
    expect(screen.getByLabelText("Experiment template")).toBeTruthy();
    expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe(
      "guided-agent",
    );
    expect((screen.getByLabelText("Repeats") as HTMLInputElement).value).toBe(
      "2",
    );
    expect(
      (screen.getByLabelText("Timeout (seconds)") as HTMLInputElement).value,
    ).toBe("30");
    expect(
      (screen.getByLabelText("Max concurrency") as HTMLInputElement).value,
    ).toBe("1");
    expect(
      (screen.getByLabelText("Budget USD (optional)") as HTMLInputElement)
        .value,
    ).toBe("2.5");
    fireEvent.change(screen.getByLabelText("Run ID"), {
      target: { value: "guided-web-run" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Validate immutable spec" }),
    );
    expect(await screen.findByText("1 compatible online")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create & start" }));
    await waitFor(() => expect(controlPlane.command).toHaveBeenCalledTimes(2));
    expect(controlPlane.command.mock.calls[0]![0]).toMatchObject({
      type: "run.create",
      spec: {
        runId: "guided-web-run",
        sandbox: {
          artifactAllowlist: expect.arrayContaining([
            "custom-task-pack/guided-web-run:task-one:guided-agent:0/native-result.json",
            "custom-task-pack/guided-web-run:task-two:guided-agent:1/native-result.json",
          ]),
        },
      },
    });
    expect(controlPlane.command.mock.calls[1]![0]).toMatchObject({
      type: "run.start",
      runId: "guided-web-run",
    });
  });

  it("restores run, trial, and server filters from the URL and queries authoritative details", async () => {
    history.replaceState(
      {},
      "",
      "/runs?runId=run-two&trialId=trial-two&trialState=completed&agentVariantId=codex&taskId=task-two",
    );
    const controlPlane = client();
    controlPlane.connect.mockResolvedValue(workflowCapabilities);
    controlPlane.query.mockImplementation((async (
      query: Record<string, unknown>,
    ) => {
      if (query.resource === "runs")
        return {
          items: [
            { accepted: { spec: { runId: "run-one" } }, state: "completed" },
            { accepted: { spec: { runId: "run-two" } }, state: "completed" },
          ],
          page: { hasMore: false, total: 2 },
        };
      if (query.resource === "run")
        return { accepted: { spec: canonicalRunSpec }, state: "completed" };
      if (query.resource === "trials")
        return {
          items: [
            {
              trialId: "trial-two",
              runId: "run-two",
              taskId: "task-two",
              agentVariantId: "codex",
              attempt: 1,
              state: "completed",
            },
          ],
          page: { hasMore: false, total: 1 },
        };
      if (query.resource === "artifacts")
        return {
          items: [
            {
              artifactId: "result-two",
              path: "run-two/trial-two/normalized-events.jsonl",
              mediaType: "application/x-ndjson",
              bytes: 20,
              redaction: "passed",
            },
          ],
          page: { hasMore: false, total: 1 },
        };
      return { items: [], page: { hasMore: false, total: 0 } };
    }) as never);
    render(<App controlPlane={controlPlane as never} />);
    const detail = await screen.findByText("Run detail · run-two");
    expect(
      detail.closest(".run-detail")?.getAttribute("data-selected-trial"),
    ).toBe("trial-two");
    await waitFor(() =>
      expect(controlPlane.query).toHaveBeenCalledWith({
        resource: "trials",
        runId: "run-two",
        state: "completed",
        agentVariantId: "codex",
        taskId: "task-two",
        page: { limit: 100 },
      }),
    );
    expect(location.search).toContain("runId=run-two");
    expect(location.search).toContain("trialId=trial-two");
    expect(await screen.findByText("result-two")).toBeTruthy();
    await waitFor(() =>
      expect(controlPlane.artifactText).toHaveBeenCalledWith(
        "result-two",
        "trial-two",
        expect.any(AbortSignal),
      ),
    );
  });

  it("sends URL-addressable server filters and appends the next cursor page", async () => {
    history.replaceState({}, "", "/defects?category=tool_recovery");
    const controlPlane = client();
    controlPlane.query.mockImplementation((async (
      query: Record<string, unknown>,
    ) => {
      if (query.resource === "defects") {
        if ((query.page as { cursor?: string }).cursor === "cursor-2")
          return {
            items: [
              {
                findingId: "finding-two",
                category: "tool_recovery",
                status: "promoted",
              },
            ],
            page: { hasMore: false, total: 2 },
          };
        return {
          items: [
            {
              findingId: "finding-one",
              category: String(query.category ?? "unknown"),
              status: String(query.status ?? "detected"),
            },
          ],
          page: { hasMore: true, nextCursor: "cursor-2", total: 2 },
        };
      }
      return { items: [], page: { hasMore: false, total: 0 } };
    }) as never);
    render(<App controlPlane={controlPlane as never} />);
    expect(await screen.findByText("finding-one")).toBeTruthy();
    expect(controlPlane.query).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: "defects",
        category: "tool_recovery",
      }),
      expect.any(AbortSignal),
    );
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "promoted" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() =>
      expect(controlPlane.query).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "defects",
          category: "tool_recovery",
          status: "promoted",
        }),
      ),
    );
    expect(location.search).toContain("status=promoted");
    fireEvent.click(screen.getByRole("button", { name: "Load next page" }));
    await waitFor(() =>
      expect(controlPlane.query).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "defects",
          page: { limit: 100, cursor: "cursor-2" },
        }),
      ),
    );
    expect(await screen.findByText("finding-two")).toBeTruthy();
  });

  it("never submits a workflow command before validation and exact confirmation", async () => {
    history.replaceState({}, "", "/analysis");
    const controlPlane = client();
    controlPlane.connect.mockResolvedValue(workflowCapabilities);
    controlPlane.command.mockResolvedValue({
      schemaVersion: 1,
      idempotencyKey: "ack",
      commandId: "ack",
      committedSequence: 1,
      committedAt: "2026-08-03T00:00:00.000Z",
      projectionVersion: 9,
    });
    render(<App controlPlane={controlPlane as never} />);
    const editor = await screen.findByLabelText("Command body JSON");
    fireEvent.change(editor, {
      target: {
        value: JSON.stringify({
          type: "run.analyze",
          runId: "run-one",
          detectorIds: ["tool-recovery"],
        }),
      },
    });
    expect(controlPlane.command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Validate command" }));
    const submit = (await screen.findByRole("button", {
      name: "Submit committed command",
    })) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type submit:run.analyze/), {
      target: { value: "submit:run.analyze-extra" },
    });
    expect(submit.disabled).toBe(true);
    expect(controlPlane.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Type submit:run.analyze/), {
      target: { value: "submit:run.analyze" },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(controlPlane.command).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "run.analyze",
          runId: "run-one",
          detectorIds: ["tool-recovery"],
        }),
      ),
    );
    expect(await screen.findByText("Committed at projection 9")).toBeTruthy();
  });
});
