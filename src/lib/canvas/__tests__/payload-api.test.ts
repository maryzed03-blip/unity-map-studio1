import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { savePayload, loadPayload, deletePayload } from "../payload-api";
import { emptyCanvasState } from "../types";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  // Inject env var for the client.
  (import.meta.env as Record<string, string>).VITE_BOARD_STORAGE_TOKEN = "test-token";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = vi.fn(impl) as unknown as typeof fetch;
}

describe("payload-api.savePayload", () => {
  it("returns parsed response on success", async () => {
    mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            payloadRef: "abc",
            payloadUrl: "https://x/abc",
            size: 42,
          }),
          { status: 200 },
        ),
    );
    const r = await savePayload(emptyCanvasState());
    expect(r).toEqual({ payloadRef: "abc", payloadUrl: "https://x/abc", size: 42 });
  });

  it("throws on success:false", async () => {
    mockFetch(
      async () => new Response(JSON.stringify({ success: false, error: "bad" }), { status: 200 }),
    );
    await expect(savePayload(emptyCanvasState())).rejects.toThrow(/bad/);
  });

  it("throws on non-2xx", async () => {
    mockFetch(async () => new Response("{}", { status: 500 }));
    await expect(savePayload(emptyCanvasState())).rejects.toThrow(/500|failed/i);
  });
});

describe("payload-api.loadPayload", () => {
  it("returns the parsed canvas state when shape is valid", async () => {
    const state = { ...emptyCanvasState(), objects: [] };
    mockFetch(async () => new Response(JSON.stringify(state), { status: 200 }));
    const r = await loadPayload("abc", "https://x/abc");
    expect(Array.isArray(r.objects)).toBe(true);
  });

  it("throws when objects array is missing", async () => {
    mockFetch(async () => new Response(JSON.stringify({ foo: 1 }), { status: 200 }));
    await expect(loadPayload("abc", "https://x/abc")).rejects.toThrow(/malformed/i);
  });

  it("throws on non-2xx", async () => {
    mockFetch(async () => new Response("nope", { status: 404 }));
    await expect(loadPayload("abc", "https://x/abc")).rejects.toThrow(/404|failed/i);
  });
});

describe("payload-api.deletePayload", () => {
  it("never throws on network rejection", async () => {
    mockFetch(async () => {
      throw new Error("network down");
    });
    await expect(deletePayload("abc")).resolves.toBeUndefined();
  });

  it("never throws on non-2xx", async () => {
    mockFetch(async () => new Response("nope", { status: 500 }));
    await expect(deletePayload("abc")).resolves.toBeUndefined();
  });

  it("resolves silently on success", async () => {
    mockFetch(async () => new Response("{}", { status: 200 }));
    await expect(deletePayload("abc")).resolves.toBeUndefined();
  });
});
