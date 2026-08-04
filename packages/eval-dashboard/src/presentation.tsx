import type { ReactNode } from "react";

const LABELS: Record<string, string> = {
  id: "Name",
  runId: "Run",
  trialId: "Test",
  taskId: "Task",
  taskPackId: "Task set",
  datasetId: "Dataset",
  findingId: "Issue",
  reportId: "Report",
  jobId: "Analysis",
  agentVariantId: "Agent",
  variantId: "Agent",
  modelId: "Model",
  workerId: "Worker",
  verifierId: "Verifier",
  detectorId: "Detector",
  packId: "Suite",
  manifestHash: "Version",
  sliceManifestHash: "Evaluation set",
  state: "Status",
  status: "Status",
  outcome: "Result",
  kind: "Type",
  title: "Title",
  version: "Version",
  owner: "Owner",
  severity: "Severity",
  confidence: "Confidence",
  score: "Score",
  costUsd: "Cost",
  p50DurationMs: "Typical duration",
  p95DurationMs: "Slow duration",
  durationMs: "Duration",
  createdAt: "Created",
  startedAt: "Started",
  completedAt: "Completed",
  updatedAt: "Updated",
  publishedAt: "Published",
  totalItems: "Items",
  selectedItems: "Selected",
  coverageRatio: "Coverage",
  trialCount: "Tests",
  passedTrials: "Passed",
  failedTrials: "Failed",
  unknownTrials: "Pending review",
  scopes: "Access",
  capacity: "Capacity",
  candidates: "Candidates",
  allowedFlakeRate: "Allowed flake rate",
  cleanupVerified: "Cleanup",
  officialBenchmark: "Official benchmark",
  sourceProvenance: "Source provenance",
};

const STATUS: Record<string, { label: string; tone: string }> = {
  passed: { label: "Passed", tone: "success" },
  pass: { label: "Passed", tone: "success" },
  completed: { label: "Completed", tone: "success" },
  committed: { label: "Completed", tone: "success" },
  verified: { label: "Verified", tone: "success" },
  validated: { label: "Validated", tone: "success" },
  human_validated: { label: "Validated", tone: "success" },
  reproduced: { label: "Reproduced", tone: "success" },
  meeting: { label: "Healthy", tone: "success" },
  active: { label: "Active", tone: "success" },
  online: { label: "Online", tone: "success" },
  running: { label: "Running", tone: "info" },
  started: { label: "Running", tone: "info" },
  queued: { label: "Queued", tone: "info" },
  pending: { label: "Pending", tone: "info" },
  detected: { label: "Detected", tone: "warning" },
  at_risk: { label: "At risk", tone: "warning" },
  partial: { label: "Partial", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  block: { label: "Blocked", tone: "danger" },
  blocked: { label: "Blocked", tone: "danger" },
  rejected: { label: "Rejected", tone: "danger" },
  revoked: { label: "Revoked", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
  unknown: { label: "No result yet", tone: "neutral" },
};

export function humanLabel(path: string): string {
  const key = path.split(".").at(-1) ?? path;
  return LABELS[key] ?? humanize(key);
}

export function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b(api|ci|ui|swe|sdlc|id)\b/gi, (word) => word.toUpperCase())
    .replace(/^\w/, (letter) => letter.toUpperCase());
}

export function HumanValue({ value, field }: { value: unknown; field: string }): JSX.Element {
  if (value === undefined || value === null || value === "") return <span className="value-empty">Not available</span>;
  const key = field.split(".").at(-1) ?? field;
  if (["state", "status", "outcome", "decision", "severity"].includes(key)) return <StatusBadge value={String(value)} />;
  if (typeof value === "boolean") return <StatusBadge value={value ? "yes" : "no"} />;
  if (typeof value === "number") return <>{formatNumber(value, key)}</>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="value-empty">None</span>;
    if (value.every((item) => ["string", "number", "boolean"].includes(typeof item))) {
      const shown = value.slice(0, 3).map(String).map(humanize);
      return <span title={value.map(String).join(", ")}>{shown.join(", ")}{value.length > 3 ? ` +${value.length - 3}` : ""}</span>;
    }
    return <span>{value.length} {value.length === 1 ? "item" : "items"}</span>;
  }
  if (typeof value === "object") return <ObjectSummary value={value as Record<string, unknown>} />;
  const text = String(value);
  if (looksLikeDate(text)) return <time dateTime={text}>{formatDate(text)}</time>;
  if (looksLikeMachineId(text, key)) return <span className="human-id" title={text}>{shortIdentifier(text)}</span>;
  return <>{humanize(text)}</>;
}

export function StatusBadge({ value, fallback = "Not available" }: { value: string; fallback?: string }): JSX.Element {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return <span className="value-empty">{fallback}</span>;
  const known = STATUS[normalized];
  if (known) return <span className={`status-badge ${known.tone}`}>{known.label}</span>;
  if (["true", "yes"].includes(normalized)) return <span className="status-badge success">Yes</span>;
  if (["false", "no"].includes(normalized)) return <span className="status-badge neutral">No</span>;
  return <span className="status-badge neutral">{humanize(value)}</span>;
}

export function TechnicalDetails({ children, label = "Technical details" }: { children: ReactNode; label?: string }): JSX.Element {
  return <details className="technical-details"><summary>{label}</summary>{children}</details>;
}

function ObjectSummary({ value }: { value: Record<string, unknown> }): JSX.Element {
  const entries = Object.entries(value);
  const recognizable = ["label", "name", "title", "status", "state", "provider", "score"]
    .map((key) => value[key])
    .find((item) => typeof item === "string" || typeof item === "number");
  return <span title={entries.map(([key, item]) => `${humanLabel(key)}: ${String(item)}`).join("\n")}>
    {recognizable !== undefined ? String(recognizable) : `${entries.length} properties`}
  </span>;
}

function formatNumber(value: number, key: string): string {
  if (/ratio|rate|coverage|confidence/i.test(key) && value >= 0 && value <= 1)
    return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(value);
  if (/durationMs/i.test(key)) return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
  if (/costUsd/i.test(key)) return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value);
  return new Intl.NumberFormat().format(value);
}

function looksLikeDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T/.test(value); }
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
function looksLikeMachineId(value: string, key: string): boolean {
  return /id|hash|reference|ref/i.test(key) || /^[a-f0-9]{32,}$/i.test(value) || /-20\d{12,}-/.test(value);
}
function shortIdentifier(value: string): string {
  const withoutFresh = value.replace(/^fresh-/, "");
  if (/^[a-f0-9]{32,}$/i.test(withoutFresh)) return `${withoutFresh.slice(0, 8)}…${withoutFresh.slice(-6)}`;
  const date = withoutFresh.match(/-20\d{12,}-.+$/)?.[0];
  return humanize(date ? withoutFresh.slice(0, -date.length) : withoutFresh);
}
