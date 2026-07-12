// Diagnostic-only test: mounts CanvasStage in isolation, with Firebase/storage
// mocked out, to check whether it enters a React "Maximum update depth
// exceeded" (#185) render loop on its own — independent of any specific
// project's saved data. Not meant to stay in the suite long-term.
import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { emptyCanvasState } from "@/lib/canvas/types";

vi.mock("@/lib/canvas/storage", () => ({
  mapStore: {
    load: vi.fn().mockResolvedValue(emptyCanvasState()),
    loadWithMeta: vi.fn().mockResolvedValue({ state: emptyCanvasState(), savedAt: Date.now() }),
    save: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@/lib/canvas/memory-cache", () => ({
  memoryCache: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("@/lib/quota-guard", () => ({
  isCritical: vi.fn().mockReturnValue(false),
}));

import { CanvasStage } from "@/components/canvas/CanvasStage";

describe("CanvasStage — #185 repro check", () => {
  it("mounts without an infinite update-depth loop (solo, non-live)", async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args);
    });

    expect(() => {
      render(
        <CanvasStage mapId="test-map" tool="select" setTool={() => {}} />,
      );
    }).not.toThrow();

    await waitFor(() => {}, { timeout: 500 }).catch(() => {});

    const loopError = errors.find((a) =>
      String(a).includes("Maximum update depth exceeded") || String(a).includes("#185"),
    );
    spy.mockRestore();
    expect(loopError).toBeUndefined();
  });

  it("mounts without a loop in live-session mode (liveSync + liveOwner)", async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args);
    });

    expect(() => {
      render(
        <CanvasStage
          mapId="test-map-live"
          tool="select"
          setTool={() => {}}
          liveSync
          liveOwner
        />,
      );
    }).not.toThrow();

    await waitFor(() => {}, { timeout: 500 }).catch(() => {});

    const loopError = errors.find((a) =>
      String(a).includes("Maximum update depth exceeded") || String(a).includes("#185"),
    );
    spy.mockRestore();
    expect(loopError).toBeUndefined();
  });
});
