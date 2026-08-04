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
});
