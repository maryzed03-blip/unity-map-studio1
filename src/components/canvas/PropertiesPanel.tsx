import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Trash2,
  Copy,
  ArrowUpToLine,
  ArrowDownToLine,
  ChevronsUp,
  ChevronsDown,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  Group,
  Ungroup,
  Lock,
  Unlock,
  Paintbrush,
  ClipboardPaste,
} from "lucide-react";
import type { CanvasObject } from "@/lib/canvas/types";
import { VoiceField } from "./VoiceField";

export type AlignMode = "left" | "right" | "center-h" | "top" | "bottom" | "center-v";

interface Props {
  object: CanvasObject;
  selectionCount?: number;
  onChange: (patch: Partial<CanvasObject>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onBringForward?: () => void;
  onSendBackward?: () => void;
  onBringToFront?: () => void;
  onSendToBack?: () => void;
  onAlign?: (mode: AlignMode) => void;
  onDistribute?: (axis: "h" | "v") => void;
  onGroup?: () => void;
  onUngroup?: () => void;
  onLockToggle?: () => void;
  onCopyStyle?: () => void;
  onPasteStyle?: () => void;
  hasStyleClipboard?: boolean;
}

const SWATCHES = [
  "#FFFFFF",
  "#F1F5F9",
  "#E2E8F0",
  "#94A3B8",
  "#0F172A",
  "#3B82F6",
  "#22C55E",
  "#F59E0B",
  "#EF4444",
  "#8B5CF6",
];

export function PropertiesPanel({
  object,
  selectionCount = 1,
  onChange,
  onDelete,
  onDuplicate,
  onBringForward,
  onSendBackward,
  onBringToFront,
  onSendToBack,
  onAlign,
  onDistribute,
  onGroup,
  onUngroup,
  onLockToggle,
  onCopyStyle,
  onPasteStyle,
  hasStyleClipboard,
}: Props) {
  const isLine = object.type === "line";
  const isConnector = object.type === "connector";
  const isRelation = isLine || isConnector;
  const isText = object.type === "text";
  const isFrame = object.type === "frame";
  const isShape = object.type === "shape";
  const isSymbol = object.type === "symbol";
  const isDrawing = object.type === "drawing";
  const showFill = !isRelation && !isDrawing;
  const supportsRotation = !isRelation && !isDrawing;
  const multi = selectionCount > 1;
  const isLocked = !!object.locked;
  const isGrouped = !!object.groupId;

  const notesLabel = isRelation ? "Σημειώσεις σχέσης" : "Πληροφορίες / Σημειώσεις";
  const notesPlaceholder = isRelation
    ? "Περιγράψτε τη σχέση μεταξύ των αντικειμένων…"
    : "Επεξηγήσεις, κλινικές σημειώσεις, παρατηρήσεις…";

  return (
    <aside
      className="absolute top-4 right-4 w-72 panel-soft p-4 z-20 max-h-[calc(100%-2rem)] overflow-y-auto"
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {multi ? `${selectionCount} επιλεγμένα` : "Ιδιότητες"}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onDuplicate}
            title="Διπλασιασμός"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive"
            onClick={onDelete}
            title="Διαγραφή"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {!multi && isText && "text" in object && (
        <div className="space-y-2 mb-3">
          <Label className="text-xs">Κείμενο</Label>
          <VoiceField
            value={(object as { text: string }).text ?? ""}
            onChange={(v) => onChange({ text: v } as Partial<CanvasObject>)}
            ariaLabel="Κείμενο"
          />
        </div>
      )}

      {!multi && isShape && "text" in object && (
        <div className="space-y-2 mb-3">
          <Label className="text-xs">Ετικέτα</Label>
          <VoiceField
            singleLine
            value={(object as { text?: string }).text ?? ""}
            onChange={(v) => onChange({ text: v } as Partial<CanvasObject>)}
            placeholder="Προαιρετικό"
            ariaLabel="Ετικέτα σχήματος"
          />
        </div>
      )}

      {!multi && isFrame && (
        <div className="space-y-2 mb-3">
          <Label className="text-xs">Τίτλος πλαισίου</Label>
          <VoiceField
            singleLine
            value={(object as { title?: string }).title ?? ""}
            onChange={(v) => onChange({ title: v } as Partial<CanvasObject>)}
            placeholder="π.χ. Ομάδα Α"
            ariaLabel="Τίτλος πλαισίου"
          />
        </div>
      )}

      {!multi && isRelation && (
        <>
          <div className="space-y-2 mb-3">
            <Label className="text-xs">Ετικέτα σχέσης</Label>
            <VoiceField
              singleLine
              value={(object as { label?: string }).label ?? ""}
              onChange={(v) => onChange({ label: v } as Partial<CanvasObject>)}
              placeholder="π.χ. προκαλεί"
              ariaLabel="Ετικέτα σχέσης"
            />
          </div>
          {/* Arrow direction + dashed style */}
          <div className="mb-3">
            <Label className="text-xs mb-1.5 block">Στυλ σχέσης</Label>
            <div className="grid grid-cols-2 gap-1.5">
              <ToggleBtn
                active={!!(object as { arrowStart?: boolean }).arrowStart}
                onClick={() =>
                  onChange({
                    arrowStart: !(object as { arrowStart?: boolean }).arrowStart,
                  } as Partial<CanvasObject>)
                }
              >
                Βέλος αρχής
              </ToggleBtn>
              <ToggleBtn
                active={!!(object as { arrowEnd?: boolean }).arrowEnd}
                onClick={() =>
                  onChange({
                    arrowEnd: !(object as { arrowEnd?: boolean }).arrowEnd,
                  } as Partial<CanvasObject>)
                }
              >
                Βέλος τέλους
              </ToggleBtn>
              <ToggleBtn
                active={!!(object as { dashed?: boolean }).dashed}
                onClick={() =>
                  onChange({
                    dashed: !(object as { dashed?: boolean }).dashed,
                  } as Partial<CanvasObject>)
                }
              >
                Διακεκομμένη
              </ToggleBtn>
            </div>
          </div>
          {/* Stage 6: connector style toggle */}
          {isConnector &&
            (() => {
              const cs =
                (object as { connectorStyle?: "line" | "lightning" }).connectorStyle ?? "line";
              return (
                <div className="mb-3">
                  <Label className="text-xs mb-1.5 block">Στυλ σύνδεσης</Label>
                  <div className="grid grid-cols-2 gap-1.5">
                    <ToggleBtn
                      active={cs === "line"}
                      onClick={() => onChange({ connectorStyle: "line" } as Partial<CanvasObject>)}
                    >
                      Σχέση
                    </ToggleBtn>
                    <ToggleBtn
                      active={cs === "lightning"}
                      onClick={() =>
                        onChange({ connectorStyle: "lightning" } as Partial<CanvasObject>)
                      }
                    >
                      Σχέση έντασης
                    </ToggleBtn>
                  </div>
                </div>
              );
            })()}
          {/* Lightning intensity slider */}
          {isConnector &&
            (object as { connectorStyle?: string }).connectorStyle === "lightning" &&
            (() => {
              const intensity = (object as { lightningIntensity?: number }).lightningIntensity ?? 4;
              return (
                <div className="mb-3">
                  <div className="flex items-center justify-between mb-1">
                    <Label className="text-xs">Βαθμός έντασης</Label>
                    <span className="text-xs text-muted-foreground tabular-nums">{intensity}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">Αραιό</span>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      step={1}
                      value={intensity}
                      onChange={(e) =>
                        onChange({ lightningIntensity: Number(e.target.value) } as Partial<CanvasObject>)
                      }
                      className="flex-1 h-1.5 accent-primary cursor-pointer"
                    />
                    <span className="text-[10px] text-muted-foreground">Πυκνό</span>
                  </div>
                </div>
              );
            })()}
          {/* Stage 6: bend points clear, when any exist */}
          {(() => {
            const bp = (object as { bendPoints?: Array<unknown> }).bendPoints;
            if (!bp || bp.length === 0) return null;
            return (
              <div className="mb-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-xs"
                  onClick={() => onChange({ bendPoints: [] } as unknown as Partial<CanvasObject>)}
                >
                  Επαναφορά σε απλή γραμμή ({bp.length} σημεία)
                </Button>
              </div>
            );
          })()}
          {/* Stage 6.1: clear an explicit curve control back to the default bow. */}
          {(() => {
            const cc = (object as { curveControl?: { x: number; y: number } }).curveControl;
            if (!cc) return null;
            return (
              <div className="mb-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-xs"
                  onClick={() =>
                    onChange({ curveControl: undefined } as unknown as Partial<CanvasObject>)
                  }
                >
                  Επαναφορά καμπύλης
                </Button>
              </div>
            );
          })()}
          {/* Stage 6.1: release a manually-set connector endpoint magnet. */}
          {isConnector && (object as { magnetLocked?: boolean }).magnetLocked && (
            <div className="mb-3">
              <Button
                variant="outline"
                size="sm"
                className="w-full text-xs"
                onClick={() =>
                  onChange({ magnetLocked: false } as unknown as Partial<CanvasObject>)
                }
              >
                Αυτόματη επιλογή σημείου
              </Button>
            </div>
          )}
          {/* Route type — connectors only */}
          {isConnector &&
            (() => {
              const connStyle = (object as { connectorStyle?: string }).connectorStyle ?? "line";
              const c = object as {
                routeType?: string;
                curved?: boolean;
              };
              const current = c.routeType === "auto" || c.routeType === "zigzag" || c.routeType === "orthogonal"
                ? "auto"
                : c.routeType ?? (c.curved ? "curved" : "straight");

              // Lightning only supports straight/auto
              const opts = connStyle === "lightning"
                ? [
                    { id: "straight" as const, label: "Ευθεία" },
                    { id: "auto" as const, label: "Αυτόματη" },
                  ]
                : [
                    { id: "straight" as const, label: "Ευθεία" },
                    { id: "curved" as const, label: "Καμπύλη" },
                    { id: "auto" as const, label: "Αυτόματη" },
                  ];

              return (
                <div className="mb-3">
                  <Label className="text-xs mb-1.5 block">Διαδρομή γραμμής</Label>
                  <div className="grid grid-cols-3 gap-1.5">
                    {opts.map((o) => (
                      <ToggleBtn
                        key={o.id}
                        active={current === o.id}
                        onClick={() =>
                          onChange({
                            routeType: o.id === "auto" ? "zigzag" : o.id,
                            curved: o.id === "curved",
                          } as Partial<CanvasObject>)
                        }
                      >
                        {o.label}
                      </ToggleBtn>
                    ))}
                  </div>
                </div>
              );
            })()}
          {/* Relationship value -5..+5 */}
          {(() => {
            const cur = (object as { relationshipValue?: number }).relationshipValue ?? 0;
            const label = cur > 0 ? `+${cur}` : cur < 0 ? `−${Math.abs(cur)}` : "0";
            const color =
              cur > 0 ? "text-green-600" : cur < 0 ? "text-red-600" : "text-muted-foreground";
            return (
              <div className="mb-3">
                <div className="flex items-center justify-between mb-1.5">
                  <Label className="text-xs">Συντελεστής επίδρασης</Label>
                  <span className={`text-xs font-semibold tabular-nums ${color}`}>{label}</span>
                </div>
                <Slider
                  value={[cur]}
                  min={-5}
                  max={5}
                  step={1}
                  onValueChange={([v]) =>
                    onChange({ relationshipValue: v } as Partial<CanvasObject>)
                  }
                />
                <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                  <span>−5</span>
                  <span>0</span>
                  <span>+5</span>
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Θετικό = ενίσχυση · 0 = ουδέτερο · Αρνητικό = αντίθεση
                </p>
              </div>
            );
          })()}
        </>
      )}

      {showFill && (
        <SwatchRow
          label="Γέμισμα"
          value={object.fill ?? "#FFFFFF"}
          onChange={(c) => onChange({ fill: c })}
        />
      )}
      <SwatchRow
        label={isRelation ? "Χρώμα γραμμής" : isDrawing ? "Χρώμα μολυβιού" : "Περίγραμμα"}
        value={object.stroke ?? "#0F172A"}
        onChange={(c) =>
          onChange({ stroke: c, ...(isSymbol ? { color: c } : {}) } as Partial<CanvasObject>)
        }
      />
      {(isText || isShape) && (
        <SwatchRow
          label="Χρώμα κειμένου"
          value={object.textColor ?? "#0F172A"}
          onChange={(c) => onChange({ textColor: c })}
        />
      )}

      <SliderRow
        label={isRelation || isDrawing ? "Πάχος γραμμής" : "Πάχος περιγράμματος"}
        value={object.strokeWidth ?? 1}
        min={0}
        max={12}
        step={1}
        onChange={(v) => onChange({ strokeWidth: v })}
      />
      <SliderRow
        label="Αδιαφάνεια"
        value={Math.round((object.opacity ?? 1) * 100)}
        min={10}
        max={100}
        step={5}
        onChange={(v) => onChange({ opacity: v / 100 })}
      />
      {(isText || isShape) && "fontSize" in object && (
        <SliderRow
          label="Μέγεθος κειμένου"
          value={(object as { fontSize?: number }).fontSize ?? 14}
          min={10}
          max={72}
          step={1}
          onChange={(v) => onChange({ fontSize: v } as Partial<CanvasObject>)}
        />
      )}
      {/* Layering */}
      <div className="grid grid-cols-4 gap-1 mt-3">
        <IconBtn title="Μπροστά (ένα επίπεδο)" onClick={onBringForward}>
          <ArrowUpToLine className="h-3.5 w-3.5" />
        </IconBtn>
        <IconBtn title="Στο μπροστινό μέρος (Ctrl+])" onClick={onBringToFront}>
          <ChevronsUp className="h-3.5 w-3.5" />
        </IconBtn>
        <IconBtn title="Πίσω (ένα επίπεδο)" onClick={onSendBackward}>
          <ArrowDownToLine className="h-3.5 w-3.5" />
        </IconBtn>
        <IconBtn title="Στο πίσω μέρος (Ctrl+[)" onClick={onSendToBack}>
          <ChevronsDown className="h-3.5 w-3.5" />
        </IconBtn>
      </div>

      {/* Group / lock / style clipboard */}
      <div className="grid grid-cols-4 gap-1 mt-2">
        {multi && (
          <IconBtn title="Ομαδοποίηση (Ctrl+G)" onClick={onGroup}>
            <Group className="h-3.5 w-3.5" />
          </IconBtn>
        )}
        {!multi && isGrouped && (
          <IconBtn title="Κατάργηση ομάδας (Ctrl+Shift+G)" onClick={onUngroup}>
            <Ungroup className="h-3.5 w-3.5" />
          </IconBtn>
        )}
        <IconBtn
          title={isLocked ? "Ξεκλείδωμα (Ctrl+L)" : "Κλείδωμα (Ctrl+L)"}
          onClick={onLockToggle}
          active={isLocked}
        >
          {isLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
        </IconBtn>
        <IconBtn title="Αντιγραφή στυλ (Ctrl+Alt+C)" onClick={onCopyStyle}>
          <Paintbrush className="h-3.5 w-3.5" />
        </IconBtn>
        <IconBtn
          title="Επικόλληση στυλ (Ctrl+Alt+V)"
          onClick={onPasteStyle}
          disabled={!hasStyleClipboard}
        >
          <ClipboardPaste className="h-3.5 w-3.5" />
        </IconBtn>
      </div>

      {/* Alignment + distribute — only shown when multi-selected */}
      {multi && onAlign && (
        <div className="mt-3 pt-3 border-t border-border">
          <Label className="text-xs mb-2 block">Στοίχιση</Label>
          <div className="grid grid-cols-6 gap-1">
            <AlignBtn title="Αριστερά" onClick={() => onAlign("left")}>
              <AlignStartHorizontal className="h-3.5 w-3.5" />
            </AlignBtn>
            <AlignBtn title="Κέντρο (Ο)" onClick={() => onAlign("center-h")}>
              <AlignCenterHorizontal className="h-3.5 w-3.5" />
            </AlignBtn>
            <AlignBtn title="Δεξιά" onClick={() => onAlign("right")}>
              <AlignEndHorizontal className="h-3.5 w-3.5" />
            </AlignBtn>
            <AlignBtn title="Πάνω" onClick={() => onAlign("top")}>
              <AlignStartVertical className="h-3.5 w-3.5" />
            </AlignBtn>
            <AlignBtn title="Κέντρο (Κ)" onClick={() => onAlign("center-v")}>
              <AlignCenterVertical className="h-3.5 w-3.5" />
            </AlignBtn>
            <AlignBtn title="Κάτω" onClick={() => onAlign("bottom")}>
              <AlignEndVertical className="h-3.5 w-3.5" />
            </AlignBtn>
          </div>
          {onDistribute && selectionCount >= 3 && (
            <>
              <Label className="text-xs mt-3 mb-2 block">Κατανομή</Label>
              <div className="grid grid-cols-2 gap-1">
                <AlignBtn title="Οριζόντια" onClick={() => onDistribute("h")}>
                  <AlignHorizontalDistributeCenter className="h-3.5 w-3.5" />
                </AlignBtn>
                <AlignBtn title="Κάθετα" onClick={() => onDistribute("v")}>
                  <AlignVerticalDistributeCenter className="h-3.5 w-3.5" />
                </AlignBtn>
              </div>
            </>
          )}
        </div>
      )}

      {/* Notes / info */}
      {!multi && (
        <div className="mt-4 pt-3 border-t border-border">
          <Label className="text-xs mb-1.5 block">{notesLabel}</Label>
          <VoiceField
            value={object.notes ?? ""}
            onChange={(v) => onChange({ notes: v } as Partial<CanvasObject>)}
            placeholder={notesPlaceholder}
            rows={4}
            ariaLabel={notesLabel}
          />
        </div>
      )}
    </aside>
  );
}

function AlignBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="h-8 rounded-md border border-border bg-background hover:bg-muted flex items-center justify-center"
    >
      {children}
    </button>
  );
}

function IconBtn({
  title,
  onClick,
  children,
  active,
  disabled,
}: {
  title: string;
  onClick?: () => void;
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`h-8 rounded-md border flex items-center justify-center transition-colors ${
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-background border-border hover:bg-muted"
      } disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {children}
    </button>
  );
}

function ToggleBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`h-7 rounded-md border text-xs px-2 flex items-center justify-center ${
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-background border-border hover:bg-muted"
      }`}
    >
      {children}
    </button>
  );
}

function SwatchRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (c: string) => void;
}) {
  return (
    <div className="mb-3">
      <Label className="text-xs mb-1.5 block">{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {SWATCHES.map((c) => (
          <button
            key={c}
            onClick={() => onChange(c)}
            className={`h-6 w-6 rounded-md border ${value.toLowerCase() === c.toLowerCase() ? "ring-2 ring-primary ring-offset-1" : "border-border"}`}
            style={{ background: c }}
            aria-label={c}
          />
        ))}
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-6 w-6 rounded-md border border-border bg-transparent cursor-pointer"
          aria-label="Προσαρμοσμένο χρώμα"
        />
      </div>
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1.5">
        <Label className="text-xs">{label}</Label>
        <span className="text-xs tabular-nums text-muted-foreground">{value}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  );
}
