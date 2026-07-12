import { describe, it, expect } from "vitest";
import { hashCanvasState } from "../schema";
import { emptyCanvasState, type CanvasState } from "../types";

const baseObj = (id: string, x = 0) => ({
  id,
  type: "shape" as const,
  shapeKind: "rectangle" as const,
  x,
  y: 0,
  width: 10,
  height: 10,
  zIndex: 1,
  createdAt: 1,
  updatedAt: 1,
});

describe("hashCanvasState", () => {
  it("is deterministic for equal states", () => {
    const s: CanvasState = { ...emptyCanvasState(), objects: [baseObj("a")] };
    expect(hashCanvasState(s)).toBe(hashCanvasState(s));
  });
  it("returns different hashes for different states", () => {
    const a: CanvasState = { ...emptyCanvasState(), objects: [baseObj("a", 0)] };
    const b: CanvasState = { ...emptyCanvasState(), objects: [baseObj("a", 5)] };
    expect(hashCanvasState(a)).not.toBe(hashCanvasState(b));
  });
  it("returns a non-empty string for empty state", () => {
    expect(hashCanvasState(emptyCanvasState())).toMatch(/.+/);
  });
});
