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

/** For non-mutating but targeted events (Click, Focus, Scroll, …): a
 *  one-line pointer that says "the user acted on this readPretty line". */
export interface LocatorInfo {
  /** 1-based line number in the readPretty tree (the state when the event
   *  fired). Lets the caller cross-reference with `detail <id>`.
   *  When the target was folded out by readPretty's collapsing rules, this
   *  is the line of the nearest rendered ancestor (the "owner"). */
  line: number;
  /** readPretty rendering of that line, with leading indentation stripped.
   *  When the target was folded, this is the owner's rendering. */
  description: string;
  /** true when the target itself isn't in the readPretty tree and we fell
   *  back to the nearest owner. */
  folded: boolean;
}

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
  /** unified-style diff truncated to first 5 lines. Empty string when the
   *  row has no DOM-mutation diff (locator-only rows or no-op rows). */
  diffPreview: string;
  /** total diff line count (excluding the @@ header) for callers that want to know more. */
  diffLines: number;
  /** number of output lines (any kind, incl. context and @@) that were
   *  cut from `diffPreview` because the row exceeded the preview cap. */
  diffPreviewDropped: number;
  /** present on locator-only rows (Click/Focus/Scroll/… without a DOM diff).
   *  Mutually exclusive with diffPreview in practice. */
  target?: LocatorInfo;
  /** present on Meta rows: the href the page navigated to. */
  metaHref?: string;
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
  /** 'pretty' (readPretty), 'html' (innerHTML, with style/svg collapsed),
   *  'raw-html' (innerHTML with style/svg verbatim), or 'raw' (rrweb json source). */
  format: "pretty" | "html" | "raw-html" | "raw";
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
  format: "pretty" | "html" | "raw-html" | "raw";
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
