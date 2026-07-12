import { describe, it, expect } from "vitest";
import {
  buildPolyPoints,
  polylinePath,
  smoothPath,
  lightningPath,
  insertBendPoint,
  removeBendPoint,
  moveBendPoint,
  nearestInsertIndex,
} from "../bend-points";

const start = { x: 0, y: 0 };
const end = { x: 100, y: 0 };

describe("bend-points helpers", () => {
  it("buildPolyPoints falls back to start+end when no bend", () => {
    expect(buildPolyPoints(start, end)).toEqual([start, end]);
    expect(buildPolyPoints(start, end, [])).toEqual([start, end]);
  });

  it("buildPolyPoints inserts bend points in order", () => {
    const bend = [
      { x: 25, y: 10 },
      { x: 75, y: -10 },
    ];
    const pts = buildPolyPoints(start, end, bend);
    expect(pts).toHaveLength(4);
    expect(pts[1]).toEqual(bend[0]);
    expect(pts[2]).toEqual(bend[1]);
  });

  it("polylinePath emits M/L commands", () => {
    expect(polylinePath([start, end])).toBe("M 0 0 L 100 0");
  });

  it("polylinePath handles empty", () => {
    expect(polylinePath([])).toBe("");
  });

  it("smoothPath returns straight line for <3 points", () => {
    expect(smoothPath([start, end])).toBe("M 0 0 L 100 0");
  });

  it("smoothPath emits Q+T commands for ≥3 points", () => {
    const d = smoothPath([start, { x: 50, y: 20 }, end]);
    expect(d).toMatch(/^M /);
    expect(d).toContain(" Q ");
    expect(d).toContain(" T ");
  });

  it("lightningPath returns a non-empty path with extra waypoints", () => {
    const d = lightningPath([start, end]);
    expect(d).toMatch(/^M /);
    // 1 + 4 deflections + 1 = 6 points → at least 5 L commands
    const ls = d.match(/L /g) ?? [];
    expect(ls.length).toBeGreaterThanOrEqual(5);
  });

  it("insertBendPoint inserts at index, clamping out-of-range", () => {
    const b = insertBendPoint(undefined, 0, { x: 10, y: 0 });
    expect(b).toEqual([{ x: 10, y: 0 }]);
    const b2 = insertBendPoint(b, 99, { x: 20, y: 0 });
    expect(b2).toHaveLength(2);
    expect(b2[1]).toEqual({ x: 20, y: 0 });
    const b3 = insertBendPoint(b2, 1, { x: 15, y: 0 });
    expect(b3[1]).toEqual({ x: 15, y: 0 });
  });

  it("removeBendPoint removes by index", () => {
    const b = [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ];
    expect(removeBendPoint(b, 1)).toEqual([
      { x: 1, y: 1 },
      { x: 3, y: 3 },
    ]);
    expect(removeBendPoint(b, 99)).toEqual(b);
    expect(removeBendPoint(undefined, 0)).toEqual([]);
  });

  it("moveBendPoint updates one entry", () => {
    const b = [{ x: 1, y: 1 }];
    expect(moveBendPoint(b, 0, { x: 9, y: 9 })).toEqual([{ x: 9, y: 9 }]);
    expect(moveBendPoint(b, 5, { x: 9, y: 9 })).toEqual(b);
  });

  it("nearestInsertIndex picks the closest segment", () => {
    const bend = [{ x: 50, y: 0 }];
    // Click near start half → segment 0
    expect(nearestInsertIndex(start, end, bend, { x: 10, y: 3 })).toBe(0);
    // Click near end half → segment 1
    expect(nearestInsertIndex(start, end, bend, { x: 90, y: 3 })).toBe(1);
  });
});
