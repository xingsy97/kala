import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Rows } from "./data-table.js";

describe("virtualized Rows", () => {
  let callbacks: FrameRequestCallback[];
  beforeEach(() => {
    callbacks = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("exposes total row semantics and coalesces scrolling into one animation frame", () => {
    const items = Array.from({ length: 100 }, (_, id) => ({ id }));
    render(<Rows items={items} fields={["id"]} />);
    const region = screen.getByRole("region");
    const table = screen.getByRole("table");
    expect(table.getAttribute("aria-rowcount")).toBe("101");
    expect(table.getAttribute("aria-colcount")).toBe("1");

    Object.defineProperty(region, "scrollTop", { configurable: true, value: 380 });
    fireEvent.scroll(region);
    Object.defineProperty(region, "scrollTop", { configurable: true, value: 760 });
    fireEvent.scroll(region);
    expect(callbacks).toHaveLength(1);
    callbacks[0]!(0);

    const renderedRows = screen.getAllByRole("row").slice(1);
    expect(renderedRows.some((row) => row.getAttribute("aria-rowindex") === "17")).toBe(true);
  });

  it("renders human labels, statuses, arrays, and objects without JSON dumps", () => {
    render(<Rows items={[{
      runId: "fresh-sdlc-journey-20260803082358-22094",
      outcome: "unknown",
      evidenceRefs: ["first", "second"],
      confidenceInterval: { lower: 0.7, upper: 0.9 },
    }]} fields={["runId", "outcome", "evidenceRefs", "confidenceInterval"]} />);
    expect(screen.getByText("Run")).toBeTruthy();
    expect(screen.getByText("No result yet")).toBeTruthy();
    expect(screen.getByText("First, Second")).toBeTruthy();
    expect(screen.getByText("2 properties")).toBeTruthy();
    expect(document.body.textContent).not.toContain('{"lower"');
    expect(document.body.textContent).not.toContain("fresh-sdlc-journey-20260803082358-22094");
  });
});
