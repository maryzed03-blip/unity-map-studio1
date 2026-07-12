import { describe, it, expect } from "vitest";
import { mergeLiveObjects } from "../live-merge";
import type { CanvasObject } from "../types";

const obj = (id: string, createdAt = 0): CanvasObject =>
  ({
    id,
    type: "shape",
    shapeKind: "rectangle",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    zIndex: 1,
    createdAt,
    updatedAt: createdAt,
  }) as CanvasObject;

describe("mergeLiveObjects", () => {
  it("keeps a genuinely new local object never seen remotely", () => {
    const seen = new Set<string>();
    const out = mergeLiveObjects([obj("local-new")], [], seen, 16000, 100000);
    expect(out.map((o) => o.id)).toEqual(["local-new"]);
  });
  it("drops a local object that was previously seen remotely but now absent (remote delete)", () => {
    const seen = new Set<string>(["deleted-id"]);
    const stale = obj("deleted-id", 0);
    const out = mergeLiveObjects([stale], [], seen, 16000, 100000);
    expect(out).toEqual([]);
  });
  it("keeps a recently-created local object even if its id was seen before", () => {
    const seen = new Set<string>(["x"]);
    const recent = obj("x", 99000); // nowMs=100000, within 16000ms window
    const out = mergeLiveObjects([recent], [], seen, 16000, 100000);
    expect(out.map((o) => o.id)).toEqual(["x"]);
  });
  it("takes remote objects as-is and merges with kept local ones", () => {
    const seen = new Set<string>();
    const remote = [obj("r1"), obj("r2")];
    const local = [obj("local")];
    const out = mergeLiveObjects(local, remote, seen, 16000, 100000);
    expect(out.map((o) => o.id).sort()).toEqual(["local", "r1", "r2"]);
    expect(seen.has("r1")).toBe(true);
    expect(seen.has("r2")).toBe(true);
  });
  it("does not duplicate when local id matches a remote id", () => {
    const seen = new Set<string>();
    const out = mergeLiveObjects([obj("a")], [obj("a")], seen, 16000, 100000);
    expect(out.length).toBe(1);
  });
});
