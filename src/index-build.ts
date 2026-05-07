// Builds an in-memory index over a recording: for each event we record its
// pretty-rendered tree before/after the event, plus the unified diff between
// them. We also keep the live DOM state at the same point so callers can
// request the html form on demand without re-walking the whole stream.

import * as fs from "node:fs";
import { applyEvent, createInitialDom, DomState } from "./dom";
import { eventLabel, isKeyInteraction, isMouseMove } from "./event-name";
import { renderPretty, renderHtml } from "./pretty";
import { diffLines } from "./diff";
import { buildLocator, getEventTargetId } from "./locator";
import { EventType, RRWebEvent } from "./types";

export interface IndexedEvent {
  /** 1-based id, matching index in events array. */
  id: number;
  event: RRWebEvent;
  label: string;
  /** seconds since first event timestamp, fixed 6 decimals. */
  timeSec: number;
  /** pretty tree before applying this event. */
  prettyBefore: string;
  /** pretty tree after applying this event. */
  prettyAfter: string;
  /** unified diff (full, not truncated). empty when identical. */
  diff: string;
  diffLines: number;
  /** for events that don't mutate DOM but still address a node (Click,
   *  Focus, Blur, Scroll, …): a short, diff-styled locator describing where
   *  the target sits in the page. null when the event has no addressable
   *  target or its target node has been removed. */
  locator: string | null;
  /** the rrweb node id this locator points at, when known. used by list
   *  merging to coalesce same-target event chains (e.g. MouseDown+Click). */
  targetId: number | null;
  /** "high-signal" user gestures (Click / DblClick / ContextMenu) that the
   *  default list view shows even without a readPretty diff. */
  keyInteraction: boolean;
}

export interface RRWebIndex {
  events: RRWebEvent[];
  indexed: IndexedEvent[];
  /** ids of events whose pretty trees differ. */
  withDiffIds: number[];
}

export function loadEventsFromFile(filePath: string): RRWebEvent[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const json = JSON.parse(raw);
  if (Array.isArray(json)) return json as RRWebEvent[];
  if (Array.isArray((json as any)?.events)) return (json as any).events as RRWebEvent[];
  throw new Error("unrecognized rrweb file: expected an array of events or { events: [...] }");
}

export function buildIndex(events: RRWebEvent[]): RRWebIndex {
  const indexed: IndexedEvent[] = [];
  const withDiffIds: number[] = [];
  if (events.length === 0) {
    return { events, indexed, withDiffIds };
  }

  const t0 = events[0].timestamp;
  let state: DomState | null = null;
  let prevPretty = "";

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const label = eventLabel(ev);
    const timeSec = (ev.timestamp - t0) / 1000;

    let prettyBefore = prevPretty;
    let prettyAfter = prevPretty;
    let diffText = "";
    let diffLn = 0;

    if (ev.type === EventType.FullSnapshot) {
      // (re)build the dom from this snapshot. Replace any existing state.
      state = createInitialDom(ev);
      prettyAfter = renderPretty(state.doc);
    } else if (state) {
      // apply incremental
      try {
        applyEvent(state, ev);
      } catch {
        /* applier should not throw, but guard anyway */
      }
      // mouse-move-class events never affect the pretty tree, skip rendering.
      if (!isMouseMove(ev) && ev.type === EventType.IncrementalSnapshot) {
        prettyAfter = renderPretty(state.doc);
      }
    } else {
      // no snapshot yet (Meta, DomContentLoaded, etc.); pretty stays empty.
    }

    if (prettyAfter !== prettyBefore) {
      const r = diffLines(prettyBefore, prettyAfter, 2);
      diffText = r.text;
      diffLn = r.changeLines;
    }

    // for non-mutating but targeted events (clicks, focus, …), produce a
    // locator string only when the event itself produced no diff. If the
    // event already has a real diff there's no need for the redundant marker.
    let locator: string | null = null;
    let targetId: number | null = null;
    if (state && diffLn === 0 && !isMouseMove(ev)) {
      locator = buildLocator(ev, state.mirror, state.doc);
      if (locator) targetId = getEventTargetId(ev);
    }
    const keyInteraction = isKeyInteraction(ev);

    indexed.push({
      id: i + 1,
      event: ev,
      label,
      timeSec,
      prettyBefore,
      prettyAfter,
      diff: diffText,
      diffLines: diffLn,
      locator,
      targetId,
      keyInteraction,
    });
    if (diffLn > 0) withDiffIds.push(i + 1);
    prevPretty = prettyAfter;
  }

  return { events, indexed, withDiffIds };
}

/** Render the html form of the dom at a given id. Re-walks the events from
 *  the most recent FullSnapshot at-or-before `id` and re-applies in sequence
 *  — html is requested rarely and we don't want to keep N copies in memory.
 */
export function renderHtmlAt(events: RRWebEvent[], targetIdInclusive: number, includeTarget: boolean): string {
  // find FullSnapshot index <= targetIdInclusive (1-based)
  const target = targetIdInclusive - 1;
  let snapIdx = -1;
  for (let i = target; i >= 0; i--) {
    if (events[i].type === EventType.FullSnapshot) { snapIdx = i; break; }
  }
  if (snapIdx < 0) return ""; // no snapshot reached yet
  const state = createInitialDom(events[snapIdx]);
  const stop = includeTarget ? target : target - 1;
  for (let i = snapIdx + 1; i <= stop; i++) {
    try { applyEvent(state, events[i]); } catch { /* ignore */ }
  }
  return renderHtml(state.doc);
}
