import { JSDOM } from "jsdom";
import {
  buildNodeWithSN,
  createCache,
  Mirror,
  rebuild,
} from "rrweb-snapshot";
import { IncrementalSource, RRWebEvent } from "./types";

export interface DomState {
  dom: JSDOM;
  doc: Document;
  mirror: Mirror;
  cache: ReturnType<typeof createCache>;
}

export function createInitialDom(fullSnapshotEvent: RRWebEvent): DomState {
  const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
    runScripts: undefined,
    pretendToBeVisual: false,
  });
  const doc = dom.window.document;
  // wipe so rebuild can populate from scratch
  while (doc.firstChild) doc.removeChild(doc.firstChild);

  const mirror = new Mirror();
  const cache = createCache();

  rebuild(fullSnapshotEvent.data.node, {
    doc,
    mirror,
    hackCss: false,
    cache,
  });

  return { dom, doc, mirror, cache };
}

/** Apply a single rrweb event to the dom state. Best-effort: unsupported
 *  sources (canvas, font, adopted style sheets, etc.) are silently ignored —
 *  they don't affect the readPretty rendering we care about.
 */
export function applyEvent(state: DomState, ev: RRWebEvent): void {
  if (ev.type !== 3) return; // only IncrementalSnapshot mutates DOM
  const src = ev.data?.source;
  switch (src) {
    case IncrementalSource.Mutation:
      applyMutation(state, ev.data);
      break;
    case IncrementalSource.Input:
      applyInput(state, ev.data);
      break;
    case IncrementalSource.Scroll:
    case IncrementalSource.MouseMove:
    case IncrementalSource.MouseInteraction:
    case IncrementalSource.ViewportResize:
    case IncrementalSource.TouchMove:
    case IncrementalSource.MediaInteraction:
    case IncrementalSource.Selection:
    case IncrementalSource.Drag:
      // none of these mutate DOM in a way that affects innerText.
      break;
    default:
      // unknown / unsupported source — ignore.
      break;
  }
}

interface MutationData {
  texts: Array<{ id: number; value: string }>;
  attributes: Array<{ id: number; attributes: Record<string, string | null> }>;
  removes: Array<{ parentId: number; id: number }>;
  adds: Array<{
    parentId: number;
    nextId: number | null;
    node: any;
  }>;
}

function applyMutation(state: DomState, data: MutationData) {
  const { mirror, doc, cache } = state;

  // text changes
  for (const t of data.texts ?? []) {
    const node = mirror.getNode(t.id) as Text | null;
    if (node) {
      try {
        node.textContent = t.value;
      } catch {
        /* ignore */
      }
    }
  }

  // attribute changes
  for (const a of data.attributes ?? []) {
    const node = mirror.getNode(a.id) as Element | null;
    if (!node || node.nodeType !== 1) continue;
    for (const [name, value] of Object.entries(a.attributes)) {
      try {
        // rrweb encodes "remove this attribute" as null; some older payloads
        // use false. Anything else gets stringified.
        if (value === null || (value as unknown) === false) {
          node.removeAttribute(name);
        } else {
          node.setAttribute(name, String(value));
        }
      } catch {
        /* invalid attribute name; skip */
      }
    }
  }

  // removes
  for (const r of data.removes ?? []) {
    const node = mirror.getNode(r.id);
    const parent = mirror.getNode(r.parentId);
    if (node && parent) {
      try {
        parent.removeChild(node);
      } catch {
        /* ignore */
      }
    }
    if (node) mirror.removeNodeFromMap(node);
  }

  // adds — must process in dependency order: a parentId may itself be inside
  // an earlier add. We loop until stable.
  let pending = [...(data.adds ?? [])];
  let lastLen = -1;
  while (pending.length && pending.length !== lastLen) {
    lastLen = pending.length;
    const next: typeof pending = [];
    for (const add of pending) {
      const parent = mirror.getNode(add.parentId);
      if (!parent) {
        next.push(add);
        continue;
      }
      const nextSibling =
        add.nextId != null ? mirror.getNode(add.nextId) : null;

      const built = buildNodeWithSN(add.node, {
        doc: doc as Document,
        mirror,
        hackCss: false,
        cache,
        skipChild: false,
      });
      if (!built) continue;
      try {
        if (nextSibling && nextSibling.parentNode === parent) {
          (parent as Node).insertBefore(built, nextSibling);
        } else {
          (parent as Node).appendChild(built);
        }
      } catch {
        /* ignore */
      }
    }
    pending = next;
  }
}

interface InputData {
  id: number;
  text?: string;
  isChecked?: boolean;
}

function applyInput(state: DomState, data: InputData) {
  const node = state.mirror.getNode(data.id) as
    | (HTMLInputElement & { value: string })
    | null;
  if (!node || node.nodeType !== 1) return;
  const tag = (node.tagName || "").toLowerCase();
  try {
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (typeof data.text === "string") (node as any).value = data.text;
      if (typeof data.isChecked === "boolean") (node as any).checked = data.isChecked;
    } else {
      // contenteditable etc. — fall back to textContent
      if (typeof data.text === "string") node.textContent = data.text;
    }
  } catch {
    /* ignore */
  }
}
