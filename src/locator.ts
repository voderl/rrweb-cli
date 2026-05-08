// For events that don't mutate the DOM (Click, MouseDown, MouseUp, Focus,
// Blur, Scroll, …) we still want to communicate *which element was acted on*.
// We render the readPretty tree of the current state and locate the line that
// represents the target element. Output is a structured LocatorInfo — line
// number + readPretty description of that line. When the target is folded
// out of the tree, we fall back to the nearest rendered ancestor.

import { Mirror } from "rrweb-snapshot";
import { renderPrettyWithOwners } from "./pretty";
import { EventType, IncrementalSource, LocatorInfo, MouseInteractions, RRWebEvent } from "./types";

/** Given the dom state at the time of the event, return a one-line locator
 *  pointing at the event's target element. Returns null when the event has
 *  no addressable target or the target isn't reachable from the rendered
 *  tree. */
export function buildLocator(ev: RRWebEvent, mirror: Mirror, doc: Document): LocatorInfo | null {
  const targetId = extractTargetId(ev);
  if (targetId == null) return null;

  // resolve target → an Element (text nodes locate via parent)
  const node = mirror.getNode(targetId);
  if (!node) return null;
  let targetEl: Element | null = null;
  if (node.nodeType === 1) targetEl = node as Element;
  else if (node.parentNode && node.parentNode.nodeType === 1) targetEl = node.parentNode as Element;
  if (!targetEl) return null;

  const { text, owners } = renderPrettyWithOwners(doc);
  if (!text) return null;
  const lines = text.split("\n");

  // direct hit: target has its own readPretty line.
  for (let i = 0; i < owners.length; i++) {
    if (owners[i] === targetEl) {
      return { line: i + 1, description: stripLeading(lines[i]), folded: false };
    }
  }
  // folded: walk parent chain until we hit a rendered owner; describe that.
  let cur: Element | null = targetEl.parentElement;
  while (cur) {
    for (let i = 0; i < owners.length; i++) {
      if (owners[i] === cur) {
        return { line: i + 1, description: stripLeading(lines[i]), folded: true };
      }
    }
    cur = cur.parentElement;
  }
  return null;
}

function stripLeading(line: string): string {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return line.slice(n);
}

export function getEventTargetId(ev: RRWebEvent): number | null {
  return extractTargetId(ev);
}

function extractTargetId(ev: RRWebEvent): number | null {
  if (ev.type !== EventType.IncrementalSnapshot) return null;
  const d = ev.data;
  if (!d) return null;
  switch (d.source) {
    case IncrementalSource.MouseInteraction: {
      const t = d.type;
      if (t === MouseInteractions.TouchCancel) return null;
      return typeof d.id === "number" ? d.id : null;
    }
    case IncrementalSource.Scroll:
    case IncrementalSource.Input:
    case IncrementalSource.MediaInteraction:
      return typeof d.id === "number" ? d.id : null;
    case IncrementalSource.Selection: {
      const ranges = d.ranges;
      if (Array.isArray(ranges) && ranges.length > 0 && typeof ranges[0].start === "number") {
        return ranges[0].start;
      }
      return null;
    }
    default:
      return null;
  }
}
