import { EventType, IncrementalSource, MouseInteractions, RRWebEvent } from "./types";

const SOURCE_LABEL: Record<number, string> = {
  [IncrementalSource.Mutation]: "Mutation",
  [IncrementalSource.MouseMove]: "MouseMove",
  [IncrementalSource.MouseInteraction]: "MouseInteraction",
  [IncrementalSource.Scroll]: "Scroll",
  [IncrementalSource.ViewportResize]: "ViewportResize",
  [IncrementalSource.Input]: "Input",
  [IncrementalSource.TouchMove]: "TouchMove",
  [IncrementalSource.MediaInteraction]: "MediaInteraction",
  [IncrementalSource.StyleSheetRule]: "StyleSheetRule",
  [IncrementalSource.CanvasMutation]: "CanvasMutation",
  [IncrementalSource.Font]: "Font",
  [IncrementalSource.Log]: "Log",
  [IncrementalSource.Drag]: "Drag",
  [IncrementalSource.StyleDeclaration]: "StyleDeclaration",
  [IncrementalSource.Selection]: "Selection",
  [IncrementalSource.AdoptedStyleSheet]: "AdoptedStyleSheet",
  [IncrementalSource.CustomElement]: "CustomElement",
};

const MOUSE_INTERACTION_LABEL: Record<number, string> = {
  [MouseInteractions.MouseUp]: "MouseUp",
  [MouseInteractions.MouseDown]: "MouseDown",
  [MouseInteractions.Click]: "Click",
  [MouseInteractions.ContextMenu]: "ContextMenu",
  [MouseInteractions.DblClick]: "DblClick",
  [MouseInteractions.Focus]: "Focus",
  [MouseInteractions.Blur]: "Blur",
  [MouseInteractions.TouchStart]: "TouchStart",
  [MouseInteractions.TouchEnd]: "TouchEnd",
  [MouseInteractions.TouchCancel]: "TouchCancel",
};

export function eventLabel(ev: RRWebEvent): string {
  switch (ev.type) {
    case EventType.DomContentLoaded:
      return "DomContentLoaded";
    case EventType.Load:
      return "Load";
    case EventType.FullSnapshot:
      return "FullSnapshot";
    case EventType.Meta:
      return "Meta";
    case EventType.Custom:
      return `Custom${ev.data?.tag ? `(${ev.data.tag})` : ""}`;
    case EventType.Plugin:
      return `Plugin${ev.data?.plugin ? `(${ev.data.plugin})` : ""}`;
    case EventType.IncrementalSnapshot: {
      const src = ev.data?.source;
      const base = SOURCE_LABEL[src] ?? `Source(${src})`;
      if (src === IncrementalSource.MouseInteraction) {
        const t = ev.data?.type;
        const sub = MOUSE_INTERACTION_LABEL[t] ?? `Type(${t})`;
        return sub;
      }
      return base;
    }
    default:
      return `Type(${ev.type})`;
  }
}

export function isMouseMove(ev: RRWebEvent): boolean {
  return (
    ev.type === EventType.IncrementalSnapshot &&
    (ev.data?.source === IncrementalSource.MouseMove ||
      ev.data?.source === IncrementalSource.TouchMove ||
      ev.data?.source === IncrementalSource.Drag)
  );
}

/** "High-signal" gestures we always surface in the default list — clicks
 *  and their friends — even when they don't move the DOM. MouseDown / MouseUp
 *  / Focus / Blur are intentionally excluded: they're noisy and the
 *  surrounding Click usually conveys the same intent. */
export function isKeyInteraction(ev: RRWebEvent): boolean {
  if (ev.type !== EventType.IncrementalSnapshot) return false;
  if (ev.data?.source !== IncrementalSource.MouseInteraction) return false;
  const t = ev.data?.type;
  return (
    t === MouseInteractions.Click ||
    t === MouseInteractions.DblClick ||
    t === MouseInteractions.ContextMenu
  );
}
