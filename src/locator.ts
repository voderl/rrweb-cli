// For events that don't mutate the DOM (Click, MouseDown, MouseUp, Focus,
// Blur, Scroll, …) we still want to communicate *which element was acted on*.
// We render the readPretty tree of the current state, find the line that
// represents the target element, and produce a unified diff of "tree" vs
// "tree with [Target] appended to the target line". The result is a normal
// unified diff — same algorithm, same formatting as real DOM-mutation diffs.

import { Mirror } from "rrweb-snapshot";
import { diffLines } from "./diff";
import { renderPrettyWithOwners } from "./pretty";
import { EventType, IncrementalSource, MouseInteractions, RRWebEvent } from "./types";

const TARGET_TAG = "[Target]";

/** Given the dom state at the time of the event, return a unified diff that
 *  pinpoints the event's target element by appending `[Target]` to its line.
 *  Returns null when the event has no addressable target. */
export function buildLocator(ev: RRWebEvent, mirror: Mirror, doc: Document): string | null {
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

  // Build the "after" view: the same readPretty tree with [Target] appended
  // to the line that represents this element. If the element was collapsed
  // away by readPretty's folding rules, fall back to inserting a virtual
  // line under the closest rendered ancestor.
  const after = buildTargetedLines(lines, owners, targetEl);
  if (!after) return null;

  const r = diffLines(text, after.join("\n"), 2);
  return r.text || null;
}

function buildTargetedLines(
  lines: string[],
  owners: (Element | null)[],
  target: Element,
): string[] | null {
  // direct hit: target's own line is in the tree
  for (let i = 0; i < owners.length; i++) {
    if (owners[i] === target) {
      const out = lines.slice();
      out[i] = `${out[i]} ${TARGET_TAG}`;
      return out;
    }
  }
  // fallback: nearest rendered ancestor
  let cur: Element | null = target.parentElement;
  while (cur) {
    for (let i = 0; i < owners.length; i++) {
      if (owners[i] === cur) {
        const indent = leadingSpaces(lines[i]) + 2;
        const synthLine = `${" ".repeat(indent)}${describeTarget(target)} ${TARGET_TAG}`;
        return [...lines.slice(0, i + 1), synthLine, ...lines.slice(i + 1)];
      }
    }
    cur = cur.parentElement;
  }
  return null;
}

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

/** One-line readPretty-style description for `el`, used when its natural line
 *  was folded out of the tree. */
function describeTarget(el: Element): string {
  const tag = (el.tagName || "div").toLowerCase();
  const attrs: string[] = [];
  const attrNames = [
    "role", "aria-label", "aria-disabled", "aria-expanded", "aria-checked",
    "aria-selected", "aria-pressed", "disabled", "checked", "href", "type",
    "name", "for", "placeholder",
  ];
  for (const name of attrNames) {
    if (!el.hasAttribute(name)) continue;
    const v = el.getAttribute(name) ?? "";
    if (v === "false" && (name.startsWith("aria-") || name === "disabled" || name === "checked")) continue;
    if (v === "" || v === name) attrs.push(name);
    else attrs.push(`${name}=${quote(v)}`);
  }
  if (tag === "input" || tag === "textarea") {
    const val = (el as HTMLInputElement).value;
    if (val) attrs.push(`value=${quote(val)}`);
  }
  return `${tag}${attrs.length ? `[${attrs.join(" ")}]` : ""}`;
}

function quote(v: string): string {
  const norm = v.replace(/\s+/g, " ").trim();
  if (norm.length > 80) return JSON.stringify(norm.slice(0, 80) + "…");
  return JSON.stringify(norm);
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
