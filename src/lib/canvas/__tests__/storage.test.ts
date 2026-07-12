import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emptyCanvasState, type CanvasState } from "../types";

// Mock the quota-guard wrappers and the payload-api before importing storage.
const cGetDocMock = vi.fn();
const cSetDocMock = vi.fn();
vi.mock("../../quota-guard", () => ({
  cGetDoc: (...a: unknown[]) => cGetDocMock(...a),
  cSetDoc: (...a: unknown[]) => cSetDocMock(...a),
}));
vi.mock("../../firebase", () => ({ db: () => ({}) }));
vi.mock("firebase/firestore", () => ({
  doc: (..._a: unknown[]) => ({ __ref: true }),
  serverTimestamp: () => ({ __ts: true }),
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
    cGetDocMock.mockResolvedValueOnce(
      fakeSnap({ payload: inline, savedAt: { toMillis: () => 1000 } }),
    );
    const store = new FirestoreMapStore();
    const r = await store.loadWithMeta("m1");
    expect(r.state).toEqual(inline);
    expect(r.savedAt).toBe(1000);
    expect(loadPayloadMock).not.toHaveBeenCalled();
  });

  it("calls loadPayload for NEW payloadRef/payloadUrl format", async () => {
    cGetDocMock.mockResolvedValueOnce(
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
});

describe("FirestoreMapStore.save — writes metadata, not payload", () => {
  it("uploads to payload-api then writes pointer doc", async () => {
    savePayloadMock.mockResolvedValueOnce({
      payloadRef: "ref1",
      payloadUrl: "https://x/ref1",
      size: 99,
    });
    cSetDocMock.mockResolvedValueOnce(undefined);

    const store = new FirestoreMapStore();
    await store.save("m3", emptyCanvasState());

    expect(savePayloadMock).toHaveBeenCalledTimes(1);
    expect(cSetDocMock).toHaveBeenCalledTimes(1);
    const written = cSetDocMock.mock.calls[0][1] as Record<string, unknown>;
    expect(written.payloadRef).toBe("ref1");
    expect(written.payloadUrl).toBe("https://x/ref1");
    expect(written.payloadSize).toBe(99);
    expect("payload" in written).toBe(false);
  });

  it("does NOT write firestore doc if external save fails", async () => {
    savePayloadMock.mockRejectedValueOnce(new Error("boom"));
    const store = new FirestoreMapStore();
    await store.save("m4", emptyCanvasState());
    expect(cSetDocMock).not.toHaveBeenCalled();
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
    cGetDocMock.mockResolvedValueOnce(
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
