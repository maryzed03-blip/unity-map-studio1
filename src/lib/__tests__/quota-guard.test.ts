// We mock firebase/firestore so no real network call ever fires.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("firebase/firestore", () => {
  return {
    getDoc: vi.fn(async () => ({ exists: () => false, data: () => ({}) })),
    getDocs: vi.fn(async () => ({ size: 3, docs: [] })),
    setDoc: vi.fn(async () => undefined),
    addDoc: vi.fn(async () => ({ id: "x" })),
    updateDoc: vi.fn(async () => undefined),
    deleteDoc: vi.fn(async () => undefined),
    onSnapshot: vi.fn(() => () => undefined),
  };
});

import {
  cGetDoc,
  cGetDocs,
  cSetDoc,
  subscribeQuota,
  getQuotaSnapshot,
  WARN_RATIO,
  CRITICAL_RATIO,
  PER_SESSION_READ_BUDGET,
  PER_SESSION_WRITE_BUDGET,
  type QuotaSnapshot,
} from "../quota-guard";

beforeEach(() => {
  // Module state is shared across tests in the same file. We can't reset
  // the counters without re-importing, so each test bumps counters and
  // asserts only the level transition / threshold logic.
});

describe("quota-guard counters", () => {
  it("cGetDoc records 1 read", async () => {
    const before = getQuotaSnapshot().reads;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cGetDoc({} as any);
    expect(getQuotaSnapshot().reads).toBe(before + 1);
  });

  it("cGetDocs records snapshot.size reads (min 1)", async () => {
    const before = getQuotaSnapshot().reads;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cGetDocs({} as any);
    expect(getQuotaSnapshot().reads).toBe(before + 3); // size: 3 in mock
  });

  it("cSetDoc records 1 write", async () => {
    const before = getQuotaSnapshot().writes;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cSetDoc({} as any, {});
    expect(getQuotaSnapshot().writes).toBe(before + 1);
  });

  it("subscribers receive level transitions", async () => {
    const received: QuotaSnapshot[] = [];
    const unsub = subscribeQuota((s) => received.push(s));
    // Bump reads by enough to cross the warn ratio. Each cGetDoc is 1.
    const target = Math.ceil(PER_SESSION_READ_BUDGET * WARN_RATIO) + 1;
    for (let i = received[0]?.reads ?? 0; i < target; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await cGetDoc({} as any);
    }
    const levels = new Set(received.map((s) => s.level));
    expect(levels.has("warn") || levels.has("critical")).toBe(true);
    unsub();
  });

  it("threshold constants are sane", () => {
    expect(WARN_RATIO).toBeLessThan(CRITICAL_RATIO);
    expect(PER_SESSION_READ_BUDGET).toBeGreaterThan(0);
    expect(PER_SESSION_WRITE_BUDGET).toBeGreaterThan(0);
  });
});
