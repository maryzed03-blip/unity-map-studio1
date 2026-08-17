import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emptyCanvasState, type CanvasState } from "../types";

// Mock the quota-guard wrappers and the payload-api before importing storage.
const cGetDocMock = vi.fn();
const cSetDocMock = vi.fn();
const getDocFromServerMock = vi.fn();
vi.mock("../../quota-guard", () => ({
  cGetDoc: (...a: unknown[]) => cGetDocMock(...a),
  cSetDoc: (...a: unknown[]) => cSetDocMock(...a),
}));
vi.mock("../../firebase", () => ({ db: () => ({}) }));
vi.mock("firebase/firestore", () => ({
  doc: (..._a: unknown[]) => ({ __ref: true }),
  serverTimestamp: () => ({ __ts: true }),
  getDocFromServer: (...a: unknown[]) => getDocFromServerMock(...a),
}));

const loadPayloadMock = vi.fn();
const savePayloadMock = vi.fn();
const deletePayloadMock = vi.fn();
vi.mock("../payload-api", () => ({
  loadPayload: (...a: unknown[]) => loadPayloadMock(...a),
  savePayload: (...a: unknown[]) => savePayloadMock(...a),
  deletePayload: (...a: unknown[]) => deletePayloadMock(...a),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { FirestoreMapStore } from "../storage";

beforeEach(() => {
  cGetDocMock.mockReset();
  cSetDocMock.mockReset();
  loadPayloadMock.mockReset();
  savePayloadMock.mockReset();
  deletePayloadMock.mockReset();
  getDocFromServerMock.mockReset();
  // Default: verification reads back whatever was just written, i.e. the
  // write "succeeded" — matches real Firestore behavior for a normal,
  // permitted write and keeps existing save() tests focused on what was
  // sent rather than on the verification step itself.
  getDocFromServerMock.mockImplementation(() => {
    const lastWrite = cSetDocMock.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
    return Promise.resolve(fakeSnap(lastWrite));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeSnap(data: unknown) {
  return { exists: () => data != null, data: () => data };
}

describe("FirestoreMapStore.loadWithMeta — dual-read", () => {
  it("returns inline payload directly (OLD format) without calling payload-api", async () => {
    const inline: CanvasState = { ...emptyCanvasState(), objects: [] };
    getDocFromServerMock.mockResolvedValueOnce(
      fakeSnap({ payload: inline, savedAt: { toMillis: () => 1000 } }),
    );
    const store = new FirestoreMapStore();
    const r = await store.loadWithMeta("m1");
    expect(r.state).toEqual(inline);
    expect(r.savedAt).toBe(1000);
    expect(loadPayloadMock).not.toHaveBeenCalled();
  });

  it("calls loadPayload for NEW payloadRef/payloadUrl format", async () => {
    getDocFromServerMock.mockResolvedValueOnce(
      fakeSnap({
        payloadRef: "abc",
        payloadUrl: "https://x/abc",
        savedAt: { toMillis: () => 2000 },
      }),
    );
    const remoteState: CanvasState = { ...emptyCanvasState(), objects: [] };
    loadPayloadMock.mockResolvedValueOnce(remoteState);

    const store = new FirestoreMapStore();
    const r = await store.loadWithMeta("m2");
    expect(loadPayloadMock).toHaveBeenCalledWith("abc", "https://x/abc");
    expect(r.state).toEqual(remoteState);
    expect(r.savedAt).toBe(2000);
  });

  it("falls back to cGetDoc when getDocFromServer fails (e.g. offline)", async () => {
    getDocFromServerMock.mockRejectedValueOnce(new Error("client is offline"));
    const inline: CanvasState = { ...emptyCanvasState(), objects: [] };
    cGetDocMock.mockResolvedValueOnce(fakeSnap({ payload: inline, savedAt: { toMillis: () => 3000 } }));

    const store = new FirestoreMapStore();
    const r = await store.loadWithMeta("m-offline");
    expect(r.state).toEqual(inline);
    expect(r.savedAt).toBe(3000);
  });
});

describe("FirestoreMapStore.save — always writes directly to Firestore", () => {
  it("writes the full payload directly to Firestore and never calls the external payload API", async () => {
    cSetDocMock.mockResolvedValueOnce(undefined);
    const state: CanvasState = { ...emptyCanvasState(), objects: [] };

    const store = new FirestoreMapStore();
    await store.save("m3", state);

    expect(savePayloadMock).not.toHaveBeenCalled();
    expect(cSetDocMock).toHaveBeenCalledTimes(1);
    const written = cSetDocMock.mock.calls[0][1] as Record<string, unknown>;
    expect(written.payload).toEqual(state);
    expect(written.payloadRef).toBeNull();
    expect(written.payloadUrl).toBeNull();
  });

  it("save never depends on the external payload API succeeding — it's not called at all", async () => {
    savePayloadMock.mockRejectedValueOnce(new Error("external API unreachable"));
    cSetDocMock.mockResolvedValueOnce(undefined);

    const store = new FirestoreMapStore();
    await store.save("m4", emptyCanvasState());

    expect(savePayloadMock).not.toHaveBeenCalled();
    expect(cSetDocMock).toHaveBeenCalledTimes(1);
  });
});

describe("FirestoreMapStore.save — inline mode (live sessions, rooms, groups)", () => {
  it("writes the full payload directly to Firestore and never calls the external payload API", async () => {
    cSetDocMock.mockResolvedValueOnce(undefined);
    const state: CanvasState = { ...emptyCanvasState(), objects: [] };

    const store = new FirestoreMapStore();
    await store.save("room-1-board", state, { inline: true });

    expect(savePayloadMock).not.toHaveBeenCalled();
    expect(cSetDocMock).toHaveBeenCalledTimes(1);
    const written = cSetDocMock.mock.calls[0][1] as Record<string, unknown>;
    expect(written.payload).toEqual(state);
    expect(written.payloadRef).toBeNull();
    expect(written.payloadUrl).toBeNull();
  });

  it("inline save still succeeds even when the external payload API would have failed", async () => {
    savePayloadMock.mockRejectedValueOnce(new Error("external API unreachable"));
    cSetDocMock.mockResolvedValueOnce(undefined);

    const store = new FirestoreMapStore();
    await store.save("room-2-board", emptyCanvasState(), { inline: true });

    // The whole point: inline saves must not depend on savePayload at all.
    expect(savePayloadMock).not.toHaveBeenCalled();
    expect(cSetDocMock).toHaveBeenCalledTimes(1);
  });

  it("a subsequent loadWithMeta prefers the fresh inline payload over a stale external pointer", async () => {
    // Simulate a board that once had an external payloadRef/Url, then got an
    // inline save on top (payloadRef/Url explicitly nulled by save()).
    getDocFromServerMock.mockResolvedValueOnce(
      fakeSnap({
        payload: { ...emptyCanvasState(), objects: [] },
        payloadRef: null,
        payloadUrl: null,
        savedAt: { toMillis: () => 5000 },
      }),
    );
    const store = new FirestoreMapStore();
    const r = await store.loadWithMeta("room-3-board");
    expect(loadPayloadMock).not.toHaveBeenCalled();
    expect(r.savedAt).toBe(5000);
  });
});

describe("FirestoreMapStore.save — write verification", () => {
  it("retries once, then throws (and shows an error) when the server content STILL doesn't match after the retry — simulates a persistent security rule rejection, not a timing fluke", async () => {
    cSetDocMock.mockResolvedValue(undefined);
    // Server still has OLD content on BOTH attempts — the write never
    // actually lands there, even though cSetDoc's promise resolves
    // "successfully" each time (Firestore's local-cache-first optimistic
    // write behavior).
    const staleSnap = fakeSnap({ payload: { ...emptyCanvasState(), objects: [{ id: "old-untouched" }] } });
    getDocFromServerMock.mockResolvedValueOnce(staleSnap).mockResolvedValueOnce(staleSnap);

    const store = new FirestoreMapStore();
    const state: CanvasState = { ...emptyCanvasState(), objects: [{ id: "new-edit" } as never] };
    await expect(store.save("m5", state)).rejects.toThrow();
    // Confirms a retry actually happened (write attempted twice).
    expect(cSetDocMock).toHaveBeenCalledTimes(2);
  }, 10000);

  it("succeeds silently when the server content matches what was sent", async () => {
    cSetDocMock.mockResolvedValueOnce(undefined);
    const store = new FirestoreMapStore();
    const state: CanvasState = { ...emptyCanvasState(), objects: [] };
    await expect(store.save("m6", state)).resolves.toBeUndefined();
  });

  it("recovers on retry if the first mismatch was transient — write succeeds without surfacing an error", async () => {
    cSetDocMock.mockResolvedValue(undefined);
    const state: CanvasState = { ...emptyCanvasState(), objects: [{ id: "new-edit" } as never] };
    const sanitized = JSON.parse(JSON.stringify(state));
    getDocFromServerMock
      .mockResolvedValueOnce(fakeSnap({ payload: { ...emptyCanvasState(), objects: [{ id: "old-untouched" }] } }))
      .mockResolvedValueOnce(fakeSnap({ payload: sanitized }));

    const store = new FirestoreMapStore();
    await expect(store.save("m7", state)).resolves.toBeUndefined();
    expect(cSetDocMock).toHaveBeenCalledTimes(2);
  }, 10000);
});
