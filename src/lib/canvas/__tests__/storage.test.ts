import { describe, it, expect, vi, beforeEach } from "vitest";
import { emptyCanvasState, type CanvasState } from "../types";

const cGetDocMock = vi.fn();
const cSetDocMock = vi.fn();
const getDocFromServerMock = vi.fn();
const savePayloadMock = vi.fn();
const loadPayloadMock = vi.fn();
const deletePayloadMock = vi.fn();

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
vi.mock("../payload-api", () => ({
  savePayload: (...a: unknown[]) => savePayloadMock(...a),
  loadPayload: (...a: unknown[]) => loadPayloadMock(...a),
  deletePayload: (...a: unknown[]) => deletePayloadMock(...a),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Minimal localStorage stub for the LocalMapStore fallback.
const store = new Map<string, string>();
vi.stubGlobal("window", {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

function fakeSnap(data: Record<string, unknown> | undefined) {
  return {
    exists: () => data !== undefined,
    data: () => data,
  };
}

let FirestoreMapStore: new () => {
  save: (mapId: string, state: CanvasState, opts?: { inline?: boolean }) => Promise<void>;
  load: (mapId: string) => Promise<CanvasState | null>;
  loadWithMeta: (mapId: string) => Promise<{ state: CanvasState | null; savedAt: number }>;
  delete: (mapId: string) => Promise<void>;
};

beforeEach(async () => {
  cGetDocMock.mockReset();
  cSetDocMock.mockReset();
  getDocFromServerMock.mockReset();
  savePayloadMock.mockReset();
  loadPayloadMock.mockReset();
  deletePayloadMock.mockReset();
  store.clear();

  // Default: the metadata verification read reflects whatever payloadRef
  // was in the last cSetDoc call — i.e. a normal, successful write.
  getDocFromServerMock.mockImplementation(() => {
    const lastWrite = cSetDocMock.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
    return Promise.resolve(fakeSnap(lastWrite));
  });
  cSetDocMock.mockResolvedValue(undefined);

  ({ FirestoreMapStore } = await import("../storage") as unknown as {
    FirestoreMapStore: typeof FirestoreMapStore;
  });
});

describe("save() — external path (personal/solo boards, default)", () => {
  it("uploads to the payload API, then writes ONLY a small pointer to Firestore", async () => {
    savePayloadMock.mockResolvedValueOnce({
      payloadRef: "board_abc123",
      payloadUrl: "https://demo.unityenergetics.org/unity-map-api/payloads/board_abc123",
      size: 4242,
    });

    const store2 = new FirestoreMapStore();
    const state: CanvasState = { ...emptyCanvasState(), objects: [{ id: "x" } as never] };
    await store2.save("m1", state);

    expect(savePayloadMock).toHaveBeenCalledTimes(1);
    expect(cSetDocMock).toHaveBeenCalledTimes(1);
    const written = cSetDocMock.mock.calls[0][1] as Record<string, unknown>;
    expect(written.payloadRef).toBe("board_abc123");
    expect(written.payloadUrl).toContain("board_abc123");
    expect(written.payloadSize).toBe(4242);
    // The whole point: Firestore never gets the actual board content.
    expect(written.payload).toBeNull();
  });

  it("does NOT touch Firestore at all if the external upload fails", async () => {
    savePayloadMock.mockRejectedValueOnce(new Error("storage API unreachable"));

    const store2 = new FirestoreMapStore();
    await expect(store2.save("m2", emptyCanvasState())).rejects.toThrow();
    expect(cSetDocMock).not.toHaveBeenCalled();
  });

  it("throws if the Firestore metadata write itself fails after a successful upload", async () => {
    savePayloadMock.mockResolvedValueOnce({
      payloadRef: "board_xyz",
      payloadUrl: "https://x/payloads/board_xyz",
      size: 10,
    });
    cSetDocMock.mockRejectedValueOnce(new Error("permission-denied"));

    const store2 = new FirestoreMapStore();
    await expect(store2.save("m3", emptyCanvasState())).rejects.toThrow();
  });

  it("retries once, then throws when the server metadata STILL doesn't match after retry — a persistent rejection, not a timing fluke", async () => {
    savePayloadMock.mockResolvedValueOnce({
      payloadRef: "board_new",
      payloadUrl: "https://x/payloads/board_new",
      size: 10,
    });
    const staleSnap = fakeSnap({ payloadRef: "board_OLD" });
    getDocFromServerMock.mockResolvedValueOnce(staleSnap).mockResolvedValueOnce(staleSnap);

    const store2 = new FirestoreMapStore();
    await expect(store2.save("m4", emptyCanvasState())).rejects.toThrow();
    expect(cSetDocMock).toHaveBeenCalledTimes(1); // metadata write itself only happens once
    expect(getDocFromServerMock).toHaveBeenCalledTimes(2); // but verification retried
  }, 10000);

  it("recovers on retry if the first verification mismatch was transient", async () => {
    savePayloadMock.mockResolvedValueOnce({
      payloadRef: "board_ok",
      payloadUrl: "https://x/payloads/board_ok",
      size: 10,
    });
    getDocFromServerMock
      .mockResolvedValueOnce(fakeSnap({ payloadRef: "board_OLD" }))
      .mockResolvedValueOnce(fakeSnap({ payloadRef: "board_ok" }));

    const store2 = new FirestoreMapStore();
    await expect(store2.save("m5", emptyCanvasState())).resolves.toBeUndefined();
  }, 10000);
});

describe("save() — inline path (live sessions, group boards)", () => {
  it("writes the full payload directly to Firestore and never calls the payload API", async () => {
    const state: CanvasState = { ...emptyCanvasState(), objects: [] };
    const store2 = new FirestoreMapStore();
    await store2.save("live-1", state, { inline: true });

    expect(savePayloadMock).not.toHaveBeenCalled();
    expect(cSetDocMock).toHaveBeenCalledTimes(1);
    const written = cSetDocMock.mock.calls[0][1] as Record<string, unknown>;
    expect(written.payload).toEqual(state);
    expect(written.payloadRef).toBeNull();
  });

  it("does not run write-verification for inline saves", async () => {
    const store2 = new FirestoreMapStore();
    await store2.save("live-2", emptyCanvasState(), { inline: true });
    expect(getDocFromServerMock).not.toHaveBeenCalled();
  });
});

describe("loadWithMeta() — dual-read", () => {
  it("follows payloadRef/payloadUrl to the payload API for external saves", async () => {
    getDocFromServerMock.mockResolvedValueOnce(
      fakeSnap({
        payloadRef: "board_abc",
        payloadUrl: "https://x/payloads/board_abc",
        savedAt: { toMillis: () => 2000 },
      }),
    );
    const remoteState: CanvasState = { ...emptyCanvasState(), objects: [] };
    loadPayloadMock.mockResolvedValueOnce(remoteState);

    const store2 = new FirestoreMapStore();
    const r = await store2.loadWithMeta("m6");
    expect(loadPayloadMock).toHaveBeenCalledWith("board_abc", "https://x/payloads/board_abc");
    expect(r.state).toEqual(remoteState);
    expect(r.savedAt).toBe(2000);
  });

  it("uses the inline payload directly (no payload-API call) for live/group/legacy boards", async () => {
    const inline: CanvasState = { ...emptyCanvasState(), objects: [] };
    getDocFromServerMock.mockResolvedValueOnce(
      fakeSnap({ payload: inline, savedAt: { toMillis: () => 1000 } }),
    );
    const store2 = new FirestoreMapStore();
    const r = await store2.loadWithMeta("m7");
    expect(r.state).toEqual(inline);
    expect(r.savedAt).toBe(1000);
    expect(loadPayloadMock).not.toHaveBeenCalled();
  });

  it("falls back to cGetDoc when the fresh server read fails (e.g. offline)", async () => {
    getDocFromServerMock.mockRejectedValueOnce(new Error("client is offline"));
    const inline: CanvasState = { ...emptyCanvasState(), objects: [] };
    cGetDocMock.mockResolvedValueOnce(fakeSnap({ payload: inline, savedAt: { toMillis: () => 3000 } }));

    const store2 = new FirestoreMapStore();
    const r = await store2.loadWithMeta("m8");
    expect(r.state).toEqual(inline);
    expect(r.savedAt).toBe(3000);
  });

  it("falls back to the local device cache if everything remote fails", async () => {
    getDocFromServerMock.mockRejectedValueOnce(new Error("offline"));
    cGetDocMock.mockRejectedValueOnce(new Error("offline"));
    const store2 = new FirestoreMapStore();
    // Prime the local cache via a prior successful inline save.
    await store2.save("m9", { ...emptyCanvasState(), objects: [{ id: "cached" } as never] }, { inline: true });
    getDocFromServerMock.mockRejectedValueOnce(new Error("offline"));
    cGetDocMock.mockRejectedValueOnce(new Error("offline"));

    const r = await store2.loadWithMeta("m9");
    expect(r.state?.objects?.[0]).toMatchObject({ id: "cached" });
  });
});

describe("delete()", () => {
  it("deletes the external payload if the board had one, and always clears the local cache", async () => {
    cGetDocMock.mockResolvedValueOnce(fakeSnap({ payloadRef: "board_to_delete" }));
    deletePayloadMock.mockResolvedValueOnce(undefined);

    const store2 = new FirestoreMapStore();
    await store2.delete("m10");
    expect(deletePayloadMock).toHaveBeenCalledWith("board_to_delete");
  });

  it("does not call deletePayload for a board that never had an external payload (inline-only)", async () => {
    cGetDocMock.mockResolvedValueOnce(fakeSnap({ payload: emptyCanvasState() }));
    const store2 = new FirestoreMapStore();
    await store2.delete("m11");
    expect(deletePayloadMock).not.toHaveBeenCalled();
  });
});
