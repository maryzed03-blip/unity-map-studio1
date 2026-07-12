// Regression test for the React #185 "Maximum update depth exceeded" bug.
// useSyncExternalStore requires getSnapshot() to return a referentially
// stable value between calls when nothing changed — otherwise React
// re-renders forever. tab-store.ts used to build a brand-new
// { tabs, activeId } object (and a brand-new tabs array, via JSON.parse) on
// every single call, which is exactly this trap. This test renders the real
// hook and asserts it settles instead of looping.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

describe("useTabStore — no infinite re-render loop", () => {
  beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
  });

  it("mounts, opens a tab, and settles without throwing 'Maximum update depth exceeded'", async () => {
    const { useTabStore, tabStore } = await import("../tab-store");

    let renderCount = 0;
    const { result, rerender } = renderHook(() => {
      renderCount++;
      return useTabStore();
    });

    expect(result.current.tabs).toEqual([]);

    act(() => {
      tabStore.openTab({ id: "a", mapId: "map-a", label: "A", kind: "personal", closeable: true });
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.activeId).toBe("a");

    const countAfterOpen = renderCount;
    rerender();
    rerender();
    // A settled store should not keep forcing new renders on unrelated
    // parent re-renders — this would spin upward without bound under the old
    // (unstable snapshot) implementation.
    expect(renderCount).toBeLessThanOrEqual(countAfterOpen + 2);
  });

  it("getSnapshot returns a stable reference across repeated calls with no mutation", async () => {
    await import("../tab-store");
    const mod = await import("../tab-store");
    const { result } = renderHook(() => mod.useTabStore());
    const first = result.current;
    // Re-render without any store mutation in between.
    const { result: result2 } = renderHook(() => mod.useTabStore());
    expect(result2.current).toBe(first);
  });
});
