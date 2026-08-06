import { useRef, useState, type ReactNode } from "react";
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
  const unavailable = administration.unavailable === true;
  const security = object(administration.security);
  const maintenance = object(administration.maintenance);
  const [reloadConfirmed, setReloadConfirmed] = useState(false);
  const [reloadMessage, setReloadMessage] = useState("");
  const [reloading, setReloading] = useState(false);
  const reloadLock = useRef(false);
  const reload = async () => {
    if (!reloadConfirmed || reloadLock.current) return;
    reloadLock.current = true;
    setReloading(true);
    try {
      await controlPlane.reloadSecurity("reload-security-registry");
      setReloadMessage(translate(locale, "admin.reloadSuccess"));
      setReloadConfirmed(false);
    } catch (error) {
      setReloadMessage(errorMessage(error));
    } finally {
      reloadLock.current = false;
      setReloading(false);
    }
  };
  return <div className="stack">
    {unavailable && <div className="human-error" role="status"><strong>Advanced security administration is not enabled</strong><p>Worker, dataset, retention and audit information below remains available. Configure the authenticated administration endpoint to manage access keys.</p></div>}
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
        <Rows items={[...array(security.principals), ...array(security.serviceKeys)]} fields={["principalId", "kind", "role", "scopes", "status"]} />
      </div>
      <div className="panel">
        <PanelHeading title={translate(locale, "admin.trustTitle")} eyebrow={translate(locale, "admin.trustEyebrow")} />
        <Rows items={array(security.trustKeys)} fields={["keyReference", "scopes", "status", "validUntil"]} />
        <p>Reload access and trust configuration from the reviewed server files. Existing sessions may lose access if the configuration changed.</p>
        <label className="check-field">
          <input aria-label="Confirm security registry reload" type="checkbox" checked={reloadConfirmed} onChange={(event) => setReloadConfirmed(event.target.checked)} />
          I understand that this may change active access permissions.
        </label>
        <button disabled={reloading || !reloadConfirmed} aria-busy={reloading} onClick={() => void reload()}>{translate(locale, "admin.reloadAction")}</button>
        {reloadMessage && <p role="status">{reloadMessage}</p>}
      </div>
    </section>
    <section className="split">
      <AdminPanel locale={locale} title="admin.retentionStatus" eyebrow="admin.maintenance"><Rows items={array(maintenance.retentionSweeps)} fields={["policyId", "dryRun", "evaluatedAt", "candidates"]} /></AdminPanel>
      <AdminPanel locale={locale} title="admin.backupTitle" eyebrow="admin.backupEyebrow"><Rows items={[...array(maintenance.backups), ...array(maintenance.restoreDrills)]} fields={["backupId", "createdAt", "verifiedAt", "transactionCount", "artifactCount", "rtoTargetSeconds", "rtoObservedSeconds", "rtoMet"]} /></AdminPanel>
    </section>
    <section className="split">
      <AdminPanel locale={locale} title="admin.agentRegistry" eyebrow="admin.noCredentials"><Rows items={pageItems(value.agents)} fields={["variantId", "backendId", "agentVersion", "model.modelId"]} /></AdminPanel>
      <AdminPanel locale={locale} title="admin.workerRegistry" eyebrow="admin.capacity"><Rows items={[...pageItems(value.workers), ...pageItems(value.sandboxes)]} fields={["registration.workerId", "session.status", "session.activeLeaseCount", "heartbeatAt", "provider", "capacity"]} /></AdminPanel>
    </section>
    <section className="split">
      <AdminPanel locale={locale} title="admin.datasetCatalog" eyebrow="admin.provenance"><Rows items={pageItems(value.datasets)} fields={["datasetId", "version", "split", "totalItems"]} /></AdminPanel>
      <AdminPanel locale={locale} title="admin.verifierVersions" eyebrow="admin.analysisAuthority"><Rows items={[...pageItems(value.verifiers), ...pageItems(value.detectors)]} fields={["verifierId", "verifierVersion", "id"]} /></AdminPanel>
    </section>
    <section className="split">
      <AdminPanel locale={locale} title="admin.protocolPolicy" eyebrow="admin.compatibility">
        <dl className="definition-list"><dt>Service version</dt><dd>{capabilities?.controlPlaneVersion ?? "Not available"}</dd><dt>Compatibility</dt><dd>{capabilities?.cleanCutover ? "Current" : "Review required"}</dd><dt>Deprecated integrations</dt><dd>{capabilities?.deprecatedCompatibilitySurfaces.length ?? 0}</dd><dt>Destructive actions</dt><dd>Explicit confirmation required</dd></dl>
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
