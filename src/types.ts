// Subset of rrweb event/data shapes we care about. We intentionally avoid
// pulling @rrweb/types so the CLI stays lean; the shapes below match what
// rrweb 1.x/2.x actually emit and what rrweb-snapshot consumes.

export enum EventType {
  DomContentLoaded = 0,
  Load = 1,
  FullSnapshot = 2,
  IncrementalSnapshot = 3,
  Meta = 4,
  Custom = 5,
  Plugin = 6,
}

export enum IncrementalSource {
  Mutation = 0,
  MouseMove = 1,
  MouseInteraction = 2,
  Scroll = 3,
  ViewportResize = 4,
  Input = 5,
  TouchMove = 6,
  MediaInteraction = 7,
  StyleSheetRule = 8,
  CanvasMutation = 9,
  Font = 10,
  Log = 11,
  Drag = 12,
  StyleDeclaration = 13,
  Selection = 14,
  AdoptedStyleSheet = 15,
  CustomElement = 16,
}

export enum MouseInteractions {
  MouseUp = 0,
  MouseDown = 1,
  Click = 2,
  ContextMenu = 3,
  DblClick = 4,
  Focus = 5,
  Blur = 6,
  TouchStart = 7,
  TouchMove_Departed = 8,
  TouchEnd = 9,
  TouchCancel = 10,
}

export interface RRWebEventBase {
  type: EventType;
  timestamp: number;
  data: any;
}

export type RRWebEvent = RRWebEventBase;

export interface ListEntry {
  /** representative id for this row. For a merged group, the first id. */
  id: number;
  /** for merged groups, the last id (inclusive). undefined when single event. */
  endId?: number;
  /** event type label, e.g. "Meta", "FullSnapshot", "Mutation", "Click", or
   *  for merged rows: "Input(×n)+Mutation(×m)". */
  event: string;
  /** seconds since first event, fixed 3 decimals. start time for groups. */
  time: number;
  /** for merged groups, end time. undefined when single event. */
  endTime?: number;
  /** unified-style diff truncated to first 5 lines. Empty string if no diff. */
  diffPreview: string;
  /** total diff line count (excluding the @@ header) for callers that want to know more. */
  diffLines: number;
  /** number of output lines (any kind, incl. context and @@) that were
   *  cut from `diffPreview` because the row exceeded the preview cap. */
  diffPreviewDropped: number;
}

export interface ListResponse {
  total: number;
  shown: number;
  page: number;
  pageSize: number;
  entries: ListEntry[];
}

export interface DetailResponse {
  id: number;
  event: string;
  time: number;
  /** the tree state at the requested point (before or after the event). */
  content: string;
  /** which side this snapshot is for. */
  side: "before" | "after";
  /** 'pretty' (readPretty), 'html' (innerHTML), or 'raw' (rrweb json source). */
  format: "pretty" | "html" | "raw";
}

export interface DiffResponse {
  id: number;
  event: string;
  time: number;
  diff: string;
  diffLines: number;
}

export interface FilterOptions {
  /** explicit set of ids/ranges to include (post-merge, the row matches if
   *  any of its constituent ids is in this set). */
  ids?: number[];
  /** comma-separated event-name substring search (case-insensitive). */
  event?: string;
  /** start time in seconds, inclusive. */
  startSec?: number;
  /** end time in seconds, inclusive. */
  endSec?: number;
  /** include MouseMove events. default false. */
  includeMouseMove?: boolean;
  /** show all events including those with empty diff. default false. */
  showNoDiff?: boolean;
  page?: number;
  pageSize?: number;
}

export interface DaemonRequest_Ping {
  kind: "ping";
}
export interface DaemonRequest_Shutdown {
  kind: "shutdown";
}
export interface DaemonRequest_List {
  kind: "list";
  filter: FilterOptions;
}
export interface DaemonRequest_Detail {
  kind: "detail";
  id: number;
  format: "pretty" | "html" | "raw";
  side: "before" | "after";
}
export interface DaemonRequest_Diff {
  kind: "diff";
  id: number;
  endId: number;
  /** 'pretty' (default, readPretty diff) or 'html' (innerHTML diff). */
  format: "pretty" | "html";
}

export type DaemonRequest =
  | DaemonRequest_Ping
  | DaemonRequest_Shutdown
  | DaemonRequest_List
  | DaemonRequest_Detail
  | DaemonRequest_Diff;

export type DaemonResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: string };
