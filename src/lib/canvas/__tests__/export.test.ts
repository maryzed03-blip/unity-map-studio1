// exportJSON triggers a download via Blob URL. We mock createObjectURL and
// the anchor click so no real DOM navigation happens, then capture the
// payload Blob to verify shape.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { exportJSON } from "../export";
import type { CanvasState } from "../types";

let captured: Blob | null = null;

beforeEach(() => {
  captured = null;
  vi.stubGlobal("URL", {
    createObjectURL: (b: Blob) => {
      captured = b;
      return "blob:mock";
    },
    revokeObjectURL: () => undefined,
  });
});

describe("exportJSON", () => {
  it("emits { schemaVersion, exportedAt, state } JSON payload", async () => {
    const state: CanvasState = {
      objects: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      settings: { foo: "bar" },
    };
    exportJSON(state, "test.json");
    expect(captured).not.toBeNull();
    const text = await (captured as Blob).text();
    const parsed = JSON.parse(text);
    expect(parsed.schemaVersion).toBe(1);
    expect(typeof parsed.exportedAt).toBe("number");
    expect(parsed.state.viewport.zoom).toBe(1);
    expect(parsed.state.settings.foo).toBe("bar");
  });
});
