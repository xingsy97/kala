import { useState, type ReactNode } from "react";
import type { ControlPlaneCapabilities } from "@agent-kernel/eval-protocol";
import { errorMessage, type DashboardControlPlane, type Page } from "../client.js";
import { translate, type Locale } from "../i18n/index.js";
import { Metric, PanelHeading, Rows } from "./data-table.js";

export function Administration({ data, capabilities, controlPlane, locale, retentionForm }: {
  data: unknown;
  capabilities?: ControlPlaneCapabilities;
  controlPlane: DashboardControlPlane;
  locale: Locale;
  retentionForm: ReactNode;
}): JSX.Element {
  const value = object(data);
  const administration = object(value.administration);
  const security = object(administration.security);
  const maintenance = object(administration.maintenance);
  const [reloadConfirmation, setReloadConfirmation] = useState("");
  const [reloadMessage, setReloadMessage] = useState("");
  const reload = async () => {
    if (reloadConfirmation !== "reload-security-registry") return;
    try {
      await controlPlane.reloadSecurity(reloadConfirmation);
      setReloadMessage(translate(locale, "admin.reloadSuccess"));
      setReloadConfirmation("");
    } catch (error) {
      setReloadMessage(errorMessage(error));
    }
  };
  return <div className="stack">
    <section className="stat-band">
      <Metric label={translate(locale, "admin.workers")} value={String(pageItems(value.workers).length)} />
      <Metric label={translate(locale, "admin.agents")} value={String(pageItems(value.agents).length)} />
      <Metric label={translate(locale, "admin.sandboxes")} value={String(pageItems(value.sandboxes).length)} />
      <Metric label={translate(locale, "admin.datasets")} value={String(pageItems(value.datasets).length)} />
      <Metric label={translate(locale, "admin.auditRecords")} value={String(pageItems(value.audit).length)} />
    </section>
    <section className="split">
      <div className="panel">
        <PanelHeading title={translate(locale, "admin.authTitle")} eyebrow={translate(locale, "admin.authEyebrow")} />
        <Rows items={[...array(security.principals), ...array(security.serviceKeys)]} fields={["principalId", "kind", "role", "serviceId", "scopes", "keyCount", "status"]} />
      </div>
      <div className="panel">
        <PanelHeading title={translate(locale, "admin.trustTitle")} eyebrow={translate(locale, "admin.trustEyebrow")} />
        <Rows items={array(security.trustKeys)} fields={["keyReference", "algorithm", "scopes", "status", "validFrom", "validUntil", "rotatedToKeyReference", "revokedAt"]} />
        <label>{translate(locale, "admin.reloadPrompt")} <code>reload-security-registry</code>
          <input aria-label={translate(locale, "admin.reloadLabel")} value={reloadConfirmation} onChange={(event) => setReloadConfirmation(event.target.value)} />
        </label>
        <button disabled={reloadConfirmation !== "reload-security-registry"} onClick={() => void reload()}>{translate(locale, "admin.reloadAction")}</button>
        {reloadMessage && <p role="status">{reloadMessage}</p>}
      </div>
    </section>
    <section className="split">
      <AdminPanel locale={locale} title="admin.retentionStatus" eyebrow="admin.maintenance"><Rows items={array(maintenance.retentionSweeps)} fields={["policyId", "dryRun", "evaluatedAt", "candidates"]} /></AdminPanel>
      <AdminPanel locale={locale} title="admin.backupTitle" eyebrow="admin.backupEyebrow"><Rows items={[...array(maintenance.backups), ...array(maintenance.restoreDrills)]} fields={["backupId", "createdAt", "verifiedAt", "transactionCount", "artifactCount", "rtoTargetSeconds", "rtoObservedSeconds", "rtoMet"]} /></AdminPanel>
    </section>
    <section className="split">
      <AdminPanel locale={locale} title="admin.agentRegistry" eyebrow="admin.noCredentials"><Rows items={pageItems(value.agents)} fields={["variantId", "backendId", "agentVersion", "model.modelId", "credentialRefs"]} /></AdminPanel>
      <AdminPanel locale={locale} title="admin.workerRegistry" eyebrow="admin.capacity"><Rows items={[...pageItems(value.workers), ...pageItems(value.sandboxes)]} fields={["registration.workerId", "registration.workerVersion", "session.status", "session.activeLeaseCount", "heartbeatAt", "registration.readiness.checkedAt", "provider", "imageDigest", "capacity"]} /></AdminPanel>
    </section>
    <section className="split">
      <AdminPanel locale={locale} title="admin.datasetCatalog" eyebrow="admin.provenance"><Rows items={pageItems(value.datasets)} fields={["datasetId", "version", "split", "totalItems", "manifestHash"]} /></AdminPanel>
      <AdminPanel locale={locale} title="admin.verifierVersions" eyebrow="admin.analysisAuthority"><Rows items={[...pageItems(value.verifiers), ...pageItems(value.detectors)]} fields={["verifierId", "verifierVersion", "id"]} /></AdminPanel>
    </section>
    <section className="split">
      <AdminPanel locale={locale} title="admin.protocolPolicy" eyebrow="admin.compatibility">
        <dl className="definition-list"><dt>Control Plane</dt><dd>{capabilities?.controlPlaneVersion ?? "—"}</dd><dt>Protocols</dt><dd>{capabilities?.protocolVersions.join(", ") ?? "—"}</dd><dt>{translate(locale, "admin.cleanCutover")}</dt><dd>{capabilities?.cleanCutover ? translate(locale, "admin.enforced") : translate(locale, "admin.unavailable")}</dd><dt>{translate(locale, "admin.legacy")}</dt><dd>{capabilities?.deprecatedCompatibilitySurfaces.length ?? "—"}</dd><dt>{translate(locale, "admin.destructive")}</dt><dd>{translate(locale, "admin.exactConfirmation")}</dd></dl>
      </AdminPanel>
      <AdminPanel locale={locale} title="admin.governanceTitle" eyebrow="admin.governanceEyebrow"><Rows items={pageItems(value.retention)} fields={["policyId", "retainDays", "protectPublishedLeaderboardEvidence", "protectRegressionEvidence"]} /></AdminPanel>
    </section>
    {retentionForm}
    <section className="panel">
      <PanelHeading title={translate(locale, "admin.auditTitle")} eyebrow={translate(locale, "admin.committedOperations")} />
      <dl className="definition-list"><dt>{translate(locale, "admin.journalTip")}</dt><dd>{String(path(value.audit, "authority.tipHash") ?? translate(locale, "admin.unavailable"))}</dd><dt>{translate(locale, "admin.verifiedQuery")}</dt><dd>{path(value.audit, "trusted") === true ? translate(locale, "admin.trusted") : translate(locale, "admin.unavailable")}</dd></dl>
      <Rows items={pageItems(value.audit)} fields={["sequence", "at", "actor.kind", "operation", "resourceType", "resourceId", "commandId"]} />
    </section>
  </div>;
}

type AdminKey = Parameters<typeof translate>[1];
function AdminPanel({ locale, title, eyebrow, children }: { locale: Locale; title: AdminKey; eyebrow: AdminKey; children: ReactNode }): JSX.Element {
  return <div className="panel"><PanelHeading title={translate(locale, title)} eyebrow={translate(locale, eyebrow)} />{children}</div>;
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function isPage(value: unknown): value is Page { return !!value && typeof value === "object" && Array.isArray((value as Page).items) && !!(value as Page).page; }
function pageItems(value: unknown): unknown[] { return isPage(value) ? value.items : []; }
function path(value: unknown, name: string): unknown { return name.split(".").reduce<unknown>((current, key) => object(current)[key], value); }
