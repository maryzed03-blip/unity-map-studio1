// Library starter templates. Each factory returns a CanvasState whose
// `objects` are ready to be persisted as the project's initial snapshot.
// Cost: identical to creating a blank project (no extra Firestore writes
// beyond the one initial snapshot write that createProject already does).

import { nanoid } from "nanoid";
import { emptyCanvasState, type CanvasObject, type CanvasState } from "./types";

const now = () => Date.now();

function shape(
  partial: Partial<CanvasObject> & { x: number; y: number; width: number; height: number },
  kind: "rectangle" | "rounded-rectangle" | "circle" | "oval" | "diamond" = "rounded-rectangle",
  text?: string,
): CanvasObject {
  return {
    id: nanoid(8),
    type: "shape",
    shapeKind: kind,
    text,
    fontSize: 14,
    fill: "#ffffff",
    stroke: "#94a3b8",
    strokeWidth: 1.5,
    rotation: 0,
    zIndex: 1,
    createdAt: now(),
    updatedAt: now(),
    ...partial,
  } as CanvasObject;
}

function text(x: number, y: number, label: string, fontSize = 16): CanvasObject {
  return {
    id: nanoid(8),
    type: "text",
    x,
    y,
    width: 200,
    height: 32,
    text: label,
    fontSize,
    rotation: 0,
    zIndex: 2,
    textColor: "#0f172a",
    createdAt: now(),
    updatedAt: now(),
  } as CanvasObject;
}

function line(x1: number, y1: number, x2: number, y2: number, arrow = true): CanvasObject {
  return {
    id: nanoid(8),
    type: "line",
    lineKind: "straight",
    x1,
    y1,
    x2,
    y2,
    arrowEnd: arrow,
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
    stroke: "#64748b",
    strokeWidth: 1.5,
    rotation: 0,
    zIndex: 0,
    createdAt: now(),
    updatedAt: now(),
  } as CanvasObject;
}

export type TemplateId =
  | "blank"
  | "timeline"
  | "cause-effect"
  | "comparison"
  | "emotion-wheel"
  | "mind-map";

export interface TemplateMeta {
  id: TemplateId;
  title: string;
  description: string;
}

export const TEMPLATES: TemplateMeta[] = [
  { id: "timeline", title: "Χρονογραμμή", description: "Διαδοχικά γεγονότα σε άξονα" },
  { id: "cause-effect", title: "Αιτία — Αποτέλεσμα", description: "Διάγραμμα αιτιότητας" },
  { id: "comparison", title: "Σύγκριση", description: "Πίνακας αντιπαραβολής" },
  {
    id: "emotion-wheel",
    title: "Τροχός συναισθημάτων",
    description: "Χάρτης για θεραπευτική χρήση",
  },
  { id: "mind-map", title: "Mind Map", description: "Κεντρική ιδέα με διακλαδώσεις" },
  { id: "blank", title: "Κενός καμβάς", description: "Ξεκινήστε από το μηδέν" },
];

export function buildTemplate(id: TemplateId): CanvasState {
  const state = emptyCanvasState();
  const objs: CanvasObject[] = [];
  switch (id) {
    case "blank":
      break;
    case "timeline": {
      objs.push(text(80, 60, "Χρονογραμμή", 22));
      objs.push(line(80, 220, 1120, 220));
      for (let i = 0; i < 5; i++) {
        const x = 120 + i * 220;
        objs.push(shape({ x: x - 40, y: 180, width: 80, height: 80 }, "circle", `${i + 1}`));
        objs.push(text(x - 60, 290, "Γεγονός…", 12));
      }
      break;
    }
    case "cause-effect": {
      objs.push(text(80, 60, "Αιτία → Αποτέλεσμα", 22));
      const causes = [
        { x: 120, y: 180 },
        { x: 120, y: 320 },
        { x: 120, y: 460 },
      ];
      const effect = { x: 720, y: 320 };
      causes.forEach((c, i) =>
        objs.push(shape({ ...c, width: 200, height: 80 }, "rounded-rectangle", `Αιτία ${i + 1}`)),
      );
      objs.push(shape({ ...effect, width: 240, height: 120 }, "rounded-rectangle", "Αποτέλεσμα"));
      causes.forEach((c) => objs.push(line(c.x + 200, c.y + 40, effect.x, effect.y + 60)));
      break;
    }
    case "comparison": {
      objs.push(text(80, 60, "Σύγκριση", 22));
      objs.push(shape({ x: 80, y: 140, width: 360, height: 480 }, "rounded-rectangle", "Α"));
      objs.push(shape({ x: 480, y: 140, width: 360, height: 480 }, "rounded-rectangle", "Β"));
      for (let i = 0; i < 3; i++) {
        objs.push(text(100, 200 + i * 80, "• Χαρακτηριστικό…", 14));
        objs.push(text(500, 200 + i * 80, "• Χαρακτηριστικό…", 14));
      }
      break;
    }
    case "emotion-wheel": {
      objs.push(text(80, 60, "Τροχός συναισθημάτων", 22));
      const cx = 600,
        cy = 400,
        r = 220;
      objs.push(shape({ x: cx - 80, y: cy - 80, width: 160, height: 160 }, "circle", "Εγώ"));
      const emotions = ["Χαρά", "Λύπη", "Θυμός", "Φόβος", "Έκπληξη", "Ντροπή", "Αγάπη", "Πρόκληση"];
      emotions.forEach((label, i) => {
        const a = (i / emotions.length) * Math.PI * 2 - Math.PI / 2;
        const x = cx + Math.cos(a) * r - 70;
        const y = cy + Math.sin(a) * r - 35;
        objs.push(shape({ x, y, width: 140, height: 70 }, "rounded-rectangle", label));
      });
      break;
    }
    case "mind-map": {
      objs.push(shape({ x: 540, y: 360, width: 200, height: 100 }, "circle", "Κεντρική ιδέα"));
      const branches = [
        { dx: -260, dy: -160 },
        { dx: 260, dy: -160 },
        { dx: -260, dy: 160 },
        { dx: 260, dy: 160 },
      ];
      branches.forEach((b, i) => {
        const x = 540 + b.dx,
          y = 360 + b.dy;
        objs.push(shape({ x, y, width: 180, height: 60 }, "rounded-rectangle", `Κλάδος ${i + 1}`));
        objs.push(line(640, 410, x + 90, y + 30, false));
      });
      break;
    }
  }
  state.objects = objs;
  return state;
}
