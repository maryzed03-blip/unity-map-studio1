import { describe, it, expect } from "vitest";
import { buildTemplate, TEMPLATES } from "../templates";

describe("buildTemplate", () => {
  for (const tpl of TEMPLATES) {
    it(`produces a valid CanvasState for "${tpl.id}"`, () => {
      const s = buildTemplate(tpl.id);
      expect(Array.isArray(s.objects)).toBe(true);
      for (const o of s.objects) {
        expect(typeof o.id).toBe("string");
        expect(o.id.length).toBeGreaterThan(0);
        // No NaN or undefined coordinates on the standard fields.
        expect(Number.isFinite(o.x)).toBe(true);
        expect(Number.isFinite(o.y)).toBe(true);
        expect(Number.isFinite(o.width)).toBe(true);
        expect(Number.isFinite(o.height)).toBe(true);
      }
    });
  }
  it("blank produces zero objects", () => {
    expect(buildTemplate("blank").objects.length).toBe(0);
  });
  it("mind-map produces a center plus four branches plus four lines", () => {
    expect(buildTemplate("mind-map").objects.length).toBe(1 + 4 + 4);
  });
});
