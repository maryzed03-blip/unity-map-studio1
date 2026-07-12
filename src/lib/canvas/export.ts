// Canvas export utilities — PNG, SVG, JSON.
// Reads the live <svg id="ums-canvas-svg"> rendered by CanvasStage,
// serializes it with inlined dimensions, and triggers a browser download.

import type { CanvasState } from "./types";

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getCanvasSvg(): SVGSVGElement | null {
  return document.getElementById("ums-canvas-svg") as SVGSVGElement | null;
}

function serializeSvg(svg: SVGSVGElement): { source: string; width: number; height: number } {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const rect = svg.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  if (!clone.getAttribute("viewBox")) {
    clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }
  const source = new XMLSerializer().serializeToString(clone);
  return { source: '<?xml version="1.0" encoding="UTF-8"?>\n' + source, width, height };
}

export function exportSVG(filename = "canvas.svg") {
  const svg = getCanvasSvg();
  if (!svg) throw new Error("Canvas not ready");
  const { source } = serializeSvg(svg);
  triggerDownload(new Blob([source], { type: "image/svg+xml;charset=utf-8" }), filename);
}

export async function exportPNG(filename = "canvas.png", scale = 2, background = "#ffffff") {
  const svg = getCanvasSvg();
  if (!svg) throw new Error("Canvas not ready");
  const { source, width, height } = serializeSvg(svg);
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to rasterize SVG"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D unavailable");
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    await new Promise<void>((resolve) => {
      canvas.toBlob((b) => {
        if (b) triggerDownload(b, filename);
        resolve();
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function exportJSON(state: CanvasState, filename = "canvas.json") {
  const payload = JSON.stringify({ schemaVersion: 1, exportedAt: Date.now(), state }, null, 2);
  triggerDownload(new Blob([payload], { type: "application/json" }), filename);
}

export function importJSON(file: File): Promise<CanvasState> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      try {
        const text = String(reader.result ?? "");
        const parsed = JSON.parse(text);
        const state = (parsed?.state ?? parsed) as CanvasState;
        if (!state || !Array.isArray(state.objects)) throw new Error("Invalid canvas file");
        resolve(state);
      } catch (e) {
        reject(e);
      }
    };
    reader.readAsText(file);
  });
}
