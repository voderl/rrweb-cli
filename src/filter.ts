import { isMouseMove } from "./event-name";
import { diffLines, truncateDiff } from "./diff";
import { IndexedEvent, renderHtmlAt, RRWebIndex } from "./index-build";
import {
  DetailResponse,
  DiffResponse,
  FilterOptions,
  ListEntry,
  ListResponse,
} from "./types";

const LIST_DIFF_PREVIEW_LINES = 3;

// Strip ` ` (context) lines from a unified diff for the list preview, leaving
// only +/- lines. Bare `@@` headers (no body left under them) are dropped too.
function stripDiffContext(diff: string): string {
  if (!diff) return "";
  const lines = diff.split("\n");
  const out: string[] = [];
  for (const ln of lines) {
    if (ln.startsWith("+") || ln.startsWith("-")) out.push(ln);
  }
  return out.join("\n");
}

interface Row {
  /** indices into idx.indexed, in order. */
  members: IndexedEvent[];
  /** label to show. */
  label: string;
  prettyBefore: string;
  prettyAfter: string;
}

/** Max gap between two adjacent events that may still be merged. */
const MERGE_MAX_GAP_SEC = 1;

const singleton = (e: IndexedEvent): Row => ({
  members: [e],
  label: e.label,
  prettyBefore: e.prettyBefore,
  prettyAfter: e.prettyAfter,
});

/** Group consecutive same-label events whose anchor timestamps stay within
 *  MERGE_MAX_GAP_SEC. The caller is expected to have already filtered the
 *  input to events that are eligible for merging (i.e. with non-empty diff). */
/** Merging rules:
 *   - non-locator events (Mutation, Input, FullSnapshot, …): consecutive
 *     same-label runs within MERGE_MAX_GAP_SEC are folded into Label(×N).
 *   - locator events (Click, Focus, MouseDown, …): consecutive events that
 *     point at the *same target node id* within the gap collapse into a
 *     single row; the row label joins each member's name with `+` so the
 *     reader sees the chain (e.g. MouseDown+Focus+MouseUp+Click).
 *   - locator and non-locator runs never absorb each other. */
function mergeSameLabelKeepLocators(events: IndexedEvent[]): Row[] {
  const rows: Row[] = [];
  let i = 0;
  while (i < events.length) {
    const e = events[i];
    if (e.locator) {
      // collapse same-target locator chain
      let j = i;
      while (
        j + 1 < events.length &&
        events[j + 1].locator &&
        events[j + 1].targetId !== null &&
        events[j + 1].targetId === e.targetId &&
        events[j + 1].timeSec - events[j].timeSec <= MERGE_MAX_GAP_SEC
      ) {
        j++;
      }
      if (j > i) {
        const group = events.slice(i, j + 1);
        rows.push({
          members: group,
          label: group.map((m) => m.label).join("+"),
          prettyBefore: group[0].prettyBefore,
          prettyAfter: group[group.length - 1].prettyAfter,
        });
      } else {
        rows.push(singleton(e));
      }
      i = j + 1;
      continue;
    }
    let j = i;
    while (
      j + 1 < events.length &&
      !events[j + 1].locator &&
      events[j + 1].label === e.label &&
      events[j + 1].timeSec - events[j].timeSec <= MERGE_MAX_GAP_SEC
    ) {
      j++;
    }
    if (j > i) {
      const group = events.slice(i, j + 1);
      rows.push({
        members: group,
        label: `${e.label}(×${group.length})`,
        prettyBefore: group[0].prettyBefore,
        prettyAfter: group[group.length - 1].prettyAfter,
      });
    } else {
      rows.push(singleton(e));
    }
    i = j + 1;
  }
  return rows;
}

export function listEvents(idx: RRWebIndex, filter: FilterOptions): ListResponse {
  const includeMM = filter.includeMouseMove ?? false;
  const showNoDiff = filter.showNoDiff ?? false;
  const idSet = filter.ids && filter.ids.length ? new Set(filter.ids) : null;

  let evFilter: ((label: string) => boolean) | null = null;
  if (filter.event) {
    const terms = filter.event
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (terms.length) {
      evFilter = (label: string) => {
        const l = label.toLowerCase();
        return terms.some((t) => l.includes(t));
      };
    }
  }

  // Stage 1: per-event filtering, before merging.
  //   default          : keep events with a real diff OR a high-signal
  //                      gesture (Click/DblClick/ContextMenu).
  //   --all            : keep everything except MouseMove/TouchMove/Drag.
  //   --mousemove      : also keep MouseMove (only meaningful with --all).
  const eligible: IndexedEvent[] = [];
  for (const e of idx.indexed) {
    if (!includeMM && isMouseMove(e.event)) continue;
    if (!showNoDiff) {
      const keep = e.diffLines > 0 || e.keyInteraction;
      if (!keep) continue;
    }
    if (filter.startSec != null && e.timeSec < filter.startSec) continue;
    if (filter.endSec != null && e.timeSec > filter.endSec) continue;
    if (evFilter && !evFilter(e.label)) continue;
    if (idSet && !idSet.has(e.id)) continue;
    eligible.push(e);
  }

  // Stage 2: decide whether to merge.
  //   - explicit --id filter: never merge (caller wants exact rows).
  //   - otherwise: merge consecutive same-label runs and same-target locator
  //     chains, since both reduce noise without losing information.
  const merge = !idSet;
  const rows = merge ? mergeSameLabelKeepLocators(eligible) : eligible.map(singleton);

  const out: ListEntry[] = [];
  for (const row of rows) {
    const first = row.members[0];
    const last = row.members[row.members.length - 1];
    const firstHasLocator = first.locator != null;

    let diff = "";
    let dl = 0;
    let target: ListEntry["target"];

    if (firstHasLocator) {
      // locator-only row (single or merged same-target chain). All members
      // of a merged chain share the target, so any member's locator works.
      target = first.locator!;
    } else if (row.members.length === 1) {
      diff = first.diff;
      dl = first.diffLines;
    } else if (row.prettyBefore !== row.prettyAfter) {
      const r = diffLines(row.prettyBefore, row.prettyAfter, 2);
      diff = r.text;
      dl = r.changeLines;
    }

    const stripped = stripDiffContext(diff);
    const trunc = dl <= LIST_DIFF_PREVIEW_LINES
      ? { text: stripped, truncated: false, droppedLines: 0 }
      : truncateDiff(stripped, LIST_DIFF_PREVIEW_LINES);
    out.push({
      id: first.id,
      endId: row.members.length > 1 ? last.id : undefined,
      event: row.label,
      time: round3(first.timeSec),
      endTime: row.members.length > 1 ? round3(last.timeSec) : undefined,
      diffPreview: trunc.text,
      diffLines: dl,
      diffPreviewDropped: trunc.droppedLines,
      target,
    });
  }

  const total = out.length;
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.max(1, filter.pageSize ?? 50);
  const start = (page - 1) * pageSize;
  const slice = out.slice(start, start + pageSize);

  return {
    total,
    shown: slice.length,
    page,
    pageSize,
    entries: slice,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Detail view for a single event id.
 *   format=pretty: readPretty tree (cached on the index)
 *   format=html:   innerHTML form (rebuilt by replaying up to the event)
 *   format=raw:    the original rrweb event json (the bytes from the file)
 *  side=after returns the state immediately after the event is applied;
 *  side=before returns it just before. For format=raw side is ignored —
 *  the event payload is the same either way. */
export function getDetail(
  idx: RRWebIndex,
  id: number,
  format: "pretty" | "html" | "raw-html" | "raw",
  side: "before" | "after",
): DetailResponse {
  const e = idx.indexed[id - 1];
  if (!e) throw new Error(notFound(idx.indexed.length, id));

  let content: string;
  if (format === "raw") {
    content = JSON.stringify(e.event, null, 2);
  } else if (format === "pretty") {
    content = side === "before" ? e.prettyBefore : e.prettyAfter;
  } else {
    // html / raw-html: re-walk to compute the requested side. raw-html keeps
    // <style> bodies and <svg> subtrees verbatim; html collapses them.
    content = renderHtmlAt(idx.events, id, side === "after", format === "raw-html");
  }

  return {
    id,
    event: e.label,
    time: round3(e.timeSec),
    content,
    side,
    format,
  };
}

export function getDiff(
  idx: RRWebIndex,
  startId: number,
  endId: number,
  format: "pretty" | "html" = "pretty",
): DiffResponse {
  const a = idx.indexed[startId - 1];
  const b = idx.indexed[endId - 1];
  if (!a) throw new Error(notFound(idx.indexed.length, startId));
  if (!b) throw new Error(notFound(idx.indexed.length, endId));
  if (startId > endId) throw new Error(`invalid id range ${startId}-${endId}`);

  if (format === "html") {
    const before = renderHtmlAt(idx.events, startId, false);
    const after = renderHtmlAt(idx.events, endId, true);
    const r = diffLines(before, after, 2);
    return {
      id: startId,
      event: startId === endId ? a.label : rangeLabel(idx, startId, endId),
      time: round3(a.timeSec),
      diff: r.text,
      diffLines: r.changeLines,
    };
  }

  if (startId === endId) {
    return {
      id: startId,
      event: a.label,
      time: round3(a.timeSec),
      diff: a.diff,
      diffLines: a.diffLines,
    };
  }
  const r = diffLines(a.prettyBefore, b.prettyAfter, 2);
  return {
    id: startId,
    event: rangeLabel(idx, startId, endId),
    time: round3(a.timeSec),
    diff: r.text,
    diffLines: r.changeLines,
  };
}

function rangeLabel(idx: RRWebIndex, startId: number, endId: number): string {
  const counts: Record<string, number> = {};
  for (let i = startId; i <= endId; i++) {
    const m = idx.indexed[i - 1];
    counts[m.label] = (counts[m.label] ?? 0) + 1;
  }
  return Object.keys(counts)
    .sort()
    .map((k) => `${k}(×${counts[k]})`)
    .join("+");
}

function notFound(total: number, id: number): string {
  if (total === 0) return `event id=${id} not found (recording has 0 events)`;
  return `event id=${id} not found. valid id range: 1-${total}. Use \`list\` to see available events.`;
}
