import { useState } from "react";

export function Rows({
  items,
  fields,
}: {
  items: unknown[];
  fields: string[];
}): JSX.Element {
  const rowHeight = 38;
  const viewportRows = 14;
  const overscan = 5;
  const virtualized = items.length > 40;
  const [scrollTop, setScrollTop] = useState(0);
  if (!items.length)
    return (
      <EmptyScene
        title="No records"
        detail="The authoritative query returned an empty page."
      />
    );
  const start = virtualized
    ? Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
    : 0;
  const end = virtualized
    ? Math.min(items.length, start + viewportRows + overscan * 2)
    : items.length;
  const visible = items.slice(start, end);
  return (
    <div
      className="table-wrap"
      tabIndex={0}
      role="region"
      aria-label="Scrollable data table"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      data-virtualized={virtualized}
      data-total-rows={items.length}
      data-rendered-rows={visible.length}
    >
      <table>
        <thead>
          <tr>
            {fields.map((name) => (
              <th key={name}>{name.split(".").at(-1)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {virtualized && start > 0 && (
            <tr aria-hidden="true" className="virtual-spacer">
              <td colSpan={fields.length} style={{ height: start * rowHeight }} />
            </tr>
          )}
          {visible.map((item, visibleIndex) => {
            const index = start + visibleIndex;
            return (
              <tr
                key={
                  field(item, "id") ||
                  field(item, "runId") ||
                  field(item, "findingId") ||
                  field(item, "jobId") ||
                  String(index)
                }
              >
                {fields.map((name) => (
                  <td key={name}>{display(path(item, name))}</td>
                ))}
              </tr>
            );
          })}
          {virtualized && end < items.length && (
            <tr aria-hidden="true" className="virtual-spacer">
              <td
                colSpan={fields.length}
                style={{ height: (items.length - end) * rowHeight }}
              />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

export function PanelHeading({ title, eyebrow }: { title: string; eyebrow: string }): JSX.Element {
  return <header className="panel-heading"><div><p>{eyebrow}</p><h2>{title}</h2></div></header>;
}

export function EmptyScene({ title, detail }: { title: string; detail: string }): JSX.Element {
  return <div className="empty-scene"><span>∅</span><h2>{title}</h2><p>{detail}</p></div>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function path(value: unknown, name: string): unknown {
  return name.split(".").reduce<unknown>((current, key) => object(current)[key], value);
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
