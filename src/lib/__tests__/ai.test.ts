// Tests for the pure helpers in ai.ts. We re-import the private `sanitize`
// and `clamp` by going through `aiGenerate`-shaped objects via a mocked
// callOpenAI. Easier: re-export them under a dev shim if needed — here we
// test via the public surface (summarizeCanvas + the visible clamping
// behaviour by parsing structured output through aiGenerate would require
// mocking fetch; instead we test summarizeCanvas + indirectly through
// importing the module's helpers).
//
// NOTE: The OpenAI network call is NEVER made — we don't call aiChat /
// aiGenerate here.

import { describe, it, expect, vi } from "vitest";
import { summarizeCanvas, maskKey, aiGenerate } from "../ai";
import type { CanvasState } from "../canvas/types";

describe("summarizeCanvas", () => {
  it("describes an empty canvas", () => {
    const s: CanvasState = { objects: [], viewport: { x: 0, y: 0, zoom: 1 }, settings: {} };
    expect(summarizeCanvas(s)).toContain("0 objects");
  });
  it("counts object types and collects labels", () => {
    const s: CanvasState = {
      objects: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: "a", type: "shape", text: "Hello" } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: "b", type: "text", text: "World" } as any,
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      settings: {},
    };
    const out = summarizeCanvas(s);
    expect(out).toContain("2 objects");
    expect(out).toContain("Hello");
    expect(out).toContain("World");
  });
});

describe("maskKey", () => {
  it("returns dash for nothing", () => {
    expect(maskKey()).toBe("—");
  });
  it("masks short keys completely", () => {
    expect(maskKey("abc")).toBe("•••");
  });
  it("keeps last 4 chars visible for long keys", () => {
    expect(maskKey("sk-abcdef12345678")).toMatch(/5678$/);
  });
});

describe("aiGenerate sanitize/clamp (via mocked fetch)", () => {
  it("clamps out-of-range coordinates and truncates long text", async () => {
    const longText = "x".repeat(500);
    const apiResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              objects: [
                {
                  type: "shape",
                  shapeKind: "rectangle",
                  x: 999999,
                  y: -999999,
                  width: 10000,
                  height: 10000,
                  text: longText,
                  fontSize: 999,
                },
                {
                  type: "text",
                  x: 0,
                  y: 0,
                  text: longText,
                },
                {
                  type: "line",
                  x1: -99999,
                  y1: 0,
                  x2: 99999,
                  y2: 0,
                  arrowEnd: true,
                },
              ],
            }),
          },
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => apiResponse,
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await aiGenerate({ apiKey: "sk-test", prompt: "anything" });
    expect(out.length).toBe(3);
    const shape = out[0] as { x: number; y: number; width: number; text?: string };
    expect(shape.x).toBeLessThanOrEqual(4000);
    expect(shape.x).toBeGreaterThanOrEqual(-2000);
    expect(shape.width).toBeLessThanOrEqual(1200);
    expect((shape.text ?? "").length).toBeLessThanOrEqual(140);

    const text = out[1] as { text: string };
    expect(text.text.length).toBeLessThanOrEqual(280);

    const line = out[2] as { x1: number; x2: number };
    expect(line.x1).toBeGreaterThanOrEqual(-2000);
    expect(line.x2).toBeLessThanOrEqual(4000);

    vi.unstubAllGlobals();
  });

  it("throws a friendly error on non-JSON model output", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "not json at all" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(aiGenerate({ apiKey: "sk", prompt: "x" })).rejects.toThrow(/JSON/);
    vi.unstubAllGlobals();
  });
});
