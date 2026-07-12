import type { SymbolObject } from "@/lib/canvas/types";

/** Renders one of the symbol glyphs inside the object's bounding box. */
export function SymbolGlyph({ o }: { o: SymbolObject }) {
  const { x, y, width: w, height: h } = o;
  const stroke = o.color ?? o.stroke ?? "#0F172A";
  const fill = o.fill ?? "#FFFFFF";
  const sw = o.strokeWidth ?? 2;
  const cx = x + w / 2,
    cy = y + h / 2;

  switch (o.symbolKind) {
    case "thunderbolt":
    case "thunderbolt-bidi": {
      // Lightning bolt scaled into bbox
      const px = (rx: number) => x + (rx / 24) * w;
      const py = (ry: number) => y + (ry / 24) * h;
      const d = `M ${px(13)} ${py(2)} L ${px(4)} ${py(14)} L ${px(11)} ${py(14)} L ${px(10)} ${py(22)} L ${px(20)} ${py(10)} L ${px(13)} ${py(10)} Z`;
      return (
        <g>
          <path d={d} fill="#FEF3C7" stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />
          {o.symbolKind === "thunderbolt-bidi" && (
            <>
              <line
                x1={x}
                y1={cy}
                x2={x - 4}
                y2={cy}
                stroke={stroke}
                strokeWidth={sw}
                markerStart="url(#ums-arrow-start)"
              />
              <line
                x1={x + w}
                y1={cy}
                x2={x + w + 4}
                y2={cy}
                stroke={stroke}
                strokeWidth={sw}
                markerEnd="url(#ums-arrow-end)"
              />
            </>
          )}
        </g>
      );
    }
    case "loop": {
      const r = Math.min(w, h) / 2 - sw;
      return (
        <g color={stroke}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={stroke} strokeWidth={sw} />
          <path
            d={`M ${cx + r} ${cy} l -4 -4 M ${cx + r} ${cy} l -4 4`}
            stroke={stroke}
            strokeWidth={sw}
            fill="none"
          />
        </g>
      );
    }
    case "process-arrow": {
      const midY = cy;
      return (
        <g color={stroke}>
          <line
            x1={x + 4}
            y1={midY}
            x2={x + w - 8}
            y2={midY}
            stroke={stroke}
            strokeWidth={sw * 1.5}
            markerEnd="url(#ums-arrow-end)"
          />
        </g>
      );
    }
    case "warning": {
      const px = (rx: number) => x + (rx / 24) * w;
      const py = (ry: number) => y + (ry / 24) * h;
      const d = `M ${px(12)} ${py(2)} L ${px(22)} ${py(20)} L ${px(2)} ${py(20)} Z`;
      return (
        <g>
          <path d={d} fill="#FEF3C7" stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />
          <text
            x={cx}
            y={y + h * 0.7}
            textAnchor="middle"
            fill={stroke}
            fontSize={Math.min(w, h) * 0.4}
            fontWeight="bold"
            style={{ pointerEvents: "none", userSelect: "none" }}
          >
            !
          </text>
        </g>
      );
    }
    case "flow-step":
    default: {
      return (
        <g>
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            rx={Math.min(w, h) * 0.2}
            fill={fill}
            stroke={stroke}
            strokeWidth={sw}
          />
          <line
            x1={x + 6}
            y1={y + h * 0.35}
            x2={x + w - 6}
            y2={y + h * 0.35}
            stroke={stroke}
            strokeWidth={1}
          />
          <line
            x1={x + 6}
            y1={y + h * 0.65}
            x2={x + w - 10}
            y2={y + h * 0.65}
            stroke={stroke}
            strokeWidth={1}
          />
        </g>
      );
    }
  }
}
