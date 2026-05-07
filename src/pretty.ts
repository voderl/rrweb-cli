// readPretty: a hierarchical, indentation-based rendering of a Document
// designed for LLM-friendly diffing. Rules:
//
//   - skip non-rendering tags entirely (script, style, head, meta, …)
//   - atomic tags (img, svg, video, …) collapse to a single self-closing line
//   - form controls expand to their semantically-relevant attributes only
//   - other elements recurse:
//       * id and class are never preserved
//       * "semantic" attributes ARE preserved (role, aria-*, disabled,
//         checked, href, title, type-on-input/button); presence of any
//         forces the element to keep its own layer in the output
//       * a wrapper element with no semantic attrs whose only meaningful
//         child is one element collapses (the child takes its place)
//       * a wrapper element with no semantic attrs whose children are all
//         text collapses to a bare text line (no `<div>` wrapper)

const SKIP_TAGS = new Set([
  "script", "style", "noscript", "template", "head", "meta", "link", "title",
]);

// rendered as a single self-closing line. children are not visited.
const ATOMIC_TAGS = new Set([
  "img", "video", "audio", "canvas", "iframe", "hr",
]);

// purely decorative tags: skipped entirely UNLESS they carry a label-like
// semantic attribute (aria-label / title / role), in which case the tag is
// still rendered as a single self-closing line so the label survives.
const DECORATIVE_TAGS = new Set(["svg", "path", "g", "use", "defs", "symbol"]);

// form controls get their own custom renderer; children skipped.
const FORM_TAGS = new Set(["input", "textarea", "select", "option", "button"]);

// always-relevant semantic attribute names. Anything matching aria-* is
// considered semantic too, except a few decorative ones explicitly excluded.
const SEMANTIC_ATTRS = new Set([
  "role", "disabled", "checked", "href", "type",
  "name", "for", "open", "selected", "value", "contenteditable",
]);
const ARIA_DECORATIVE = new Set([
  "aria-hidden", "aria-describedby", "aria-labelledby", "aria-owns",
  "aria-controls", "aria-live", "aria-busy", "aria-relevant",
  "aria-atomic", "aria-flowto",
]);

interface AttrPair { name: string; value: string; }

function isSemanticAttr(name: string): boolean {
  if (SEMANTIC_ATTRS.has(name)) return true;
  if (name.startsWith("aria-") && !ARIA_DECORATIVE.has(name)) return true;
  return false;
}

function tagOf(el: Element): string {
  return (el.tagName || "").toLowerCase();
}

function getSemanticAttrs(el: Element): AttrPair[] {
  const out: AttrPair[] = [];
  for (const a of Array.from(el.attributes)) {
    if (!isSemanticAttr(a.name)) continue;
    // drop attributes whose value is the explicit "off" form — they carry
    // no information and inflate every line they appear on.
    const v = a.value;
    if (v === "false" && (a.name.startsWith("aria-") || a.name === "disabled" || a.name === "checked")) continue;
    if (a.name === "aria-hidden" && v === "true") continue; // already filtered as decorative, double-check
    out.push({ name: a.name, value: v });
  }
  // stable ordering: role, aria-*, disabled/checked, href, type, others
  const order = (n: string) =>
    n === "role" ? 0 :
    n.startsWith("aria-") ? 1 :
    n === "disabled" || n === "checked" ? 2 :
    n === "href" ? 3 :
    n === "type" ? 4 : 5;
  out.sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));
  return out;
}

function fmtAttrs(attrs: AttrPair[]): string {
  if (!attrs.length) return "";
  const parts = attrs.map((a) => {
    // boolean-ish: render bare
    if (a.value === "" || a.value === a.name) return a.name;
    if ((a.name === "disabled" || a.name === "checked" || a.name === "open" || a.name === "selected") && a.value !== "false") {
      return a.name;
    }
    return `${a.name}=${quote(a.value)}`;
  });
  return `[${parts.join(" ")}]`;
}

function quote(v: string): string {
  const norm = collapseWS(v);
  if (norm.length > 80) return JSON.stringify(norm.slice(0, 80) + "…");
  return JSON.stringify(norm);
}

function collapseWS(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ----- render core -----

interface Block {
  /** rendered lines, already indented. */
  lines: string[];
  /** parallel array: the Element each line "belongs to". null when the line
   *  represents pure text content with no single owner. */
  owners: (Element | null)[];
}

function emptyBlock(): Block { return { lines: [], owners: [] }; }

function indent(block: Block, n: number): Block {
  if (n === 0) return block;
  const pad = "  ".repeat(n);
  return { lines: block.lines.map((l) => pad + l), owners: block.owners.slice() };
}

function concat(...bs: Block[]): Block {
  const out: string[] = [];
  const ownersOut: (Element | null)[] = [];
  for (const b of bs) {
    for (let i = 0; i < b.lines.length; i++) {
      out.push(b.lines[i]);
      ownersOut.push(b.owners[i] ?? null);
    }
  }
  return { lines: out, owners: ownersOut };
}

function renderForm(el: Element, attrs: AttrPair[]): Block {
  const tag = tagOf(el);
  const attrsToShow = attrs.filter(
    (a) => a.name !== "value" && a.name !== "type",
  );
  const type = (el.getAttribute("type") || "").toLowerCase();
  const placeholder = el.getAttribute("placeholder") ?? "";
  const value =
    tag === "input" || tag === "textarea"
      ? (el as HTMLInputElement).value ?? el.getAttribute("value") ?? ""
      : "";
  const checked = (el as HTMLInputElement).checked === true || el.hasAttribute("checked");

  const single = (line: string): Block => ({ lines: [line], owners: [el] });

  let head: string;
  if (tag === "input") {
    const t = type || "text";
    if (t === "checkbox" || t === "radio") {
      head = `input[type=${t}${checked ? " checked" : ""}${fmtAttrs(attrsToShow).replace(/^\[|\]$/g, "") ? " " + fmtAttrs(attrsToShow).slice(1, -1) : ""}]`;
    } else {
      const ph = placeholder ? ` placeholder=${quote(placeholder)}` : "";
      const v = value ? ` value=${quote(String(value))}` : "";
      const extra = fmtAttrs(attrsToShow);
      const extraInner = extra ? " " + extra.slice(1, -1) : "";
      head = `input[type=${t}${ph}${v}${extraInner}]`;
    }
    return single(head);
  }
  if (tag === "textarea") {
    const ph = placeholder ? ` placeholder=${quote(placeholder)}` : "";
    const extra = fmtAttrs(attrsToShow);
    const extraInner = extra ? " " + extra.slice(1, -1) : "";
    const v = collapseWS(String(value || el.textContent || ""));
    if (!v) return single(`textarea[${ph.trim()}${extraInner}]`.replace("[ ", "["));
    return single(`textarea[${(ph + extraInner).trim()}]: ${v}`.replace("[]: ", ": "));
  }
  if (tag === "select") {
    const v = (el as HTMLSelectElement).value ?? "";
    const extra = fmtAttrs(attrsToShow);
    return single(`select${extra}: ${collapseWS(String(v))}`.trimEnd());
  }
  if (tag === "button") {
    const text = collapseWS(el.textContent || "");
    const extra = fmtAttrs(attrsToShow);
    return single(`button${extra}${text ? `: ${text}` : ""}`);
  }
  if (tag === "option") {
    const text = collapseWS(el.textContent || "");
    const extra = fmtAttrs(attrsToShow);
    return single(`option${extra}${text ? `: ${text}` : ""}`);
  }
  return single(tag);
}

function renderAtomic(el: Element, attrs: AttrPair[]): Block {
  const tag = tagOf(el);
  const extra: AttrPair[] = [];
  if (tag === "img") {
    const alt = el.getAttribute("alt");
    if (alt) extra.push({ name: "alt", value: alt });
  }
  // merge with semantic attrs
  for (const a of attrs) if (!extra.some((e) => e.name === a.name)) extra.push(a);
  return { lines: [`${tag}${fmtAttrs(extra)}`], owners: [el] };
}

interface RenderedChild {
  kind: "text" | "element";
  block: Block;
}

function renderChildren(el: Element): RenderedChild[] {
  const out: RenderedChild[] = [];
  let textBuf = "";
  const flushText = () => {
    const t = collapseWS(textBuf);
    textBuf = "";
    if (t) out.push({ kind: "text", block: { lines: [t], owners: [null] } });
  };
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === 3) {
      textBuf += " " + (c as Text).data;
      continue;
    }
    if (c.nodeType !== 1) continue;
    const ce = c as Element;
    const tg = tagOf(ce);
    if (SKIP_TAGS.has(tg)) continue;
    if (tg === "br") { textBuf += " "; continue; }
    flushText();
    const rendered = renderElement(ce);
    if (rendered.lines.length) out.push({ kind: "element", block: rendered });
  }
  flushText();
  return out;
}

function renderElement(el: Element): Block {
  const tag = tagOf(el);
  if (SKIP_TAGS.has(tag)) return emptyBlock();
  const attrs = getSemanticAttrs(el);

  if (DECORATIVE_TAGS.has(tag)) {
    // drop entirely unless the element carries a label-like semantic.
    if (attrs.length === 0) return emptyBlock();
    return { lines: [`${tag}${fmtAttrs(attrs)}`], owners: [el] };
  }
  if (FORM_TAGS.has(tag)) return renderForm(el, attrs);
  if (ATOMIC_TAGS.has(tag)) return renderAtomic(el, attrs);

  const children = renderChildren(el);
  if (children.length === 0) {
    // empty element. only show if it carries semantics.
    if (attrs.length) return { lines: [`${tag}${fmtAttrs(attrs)}`], owners: [el] };
    return emptyBlock();
  }

  // Collapse rules — only when this wrapper has zero semantic attrs.
  if (attrs.length === 0) {
    // (a) all children are text → emit a single text line
    if (children.every((c) => c.kind === "text")) {
      const joined = collapseWS(children.map((c) => c.block.lines.join(" ")).join(" "));
      return joined ? { lines: [joined], owners: [el] } : emptyBlock();
    }
    // (b) single child element + no text → bubble that child up
    if (children.length === 1 && children[0].kind === "element") {
      return children[0].block;
    }
  }

  // Otherwise: keep this layer. head line for this element, children indented.
  const head = `${tag}${fmtAttrs(attrs)}`;

  // tiny optimization: head + a single text-only child → render as `tag[attrs]: text`
  if (children.length === 1 && children[0].kind === "text") {
    const txt = children[0].block.lines.join(" ");
    return { lines: [`${head}: ${txt}`], owners: [el] };
  }

  // tiny optimization: head + a single one-line child → inline as `tag[attrs] > child`
  if (children.length === 1 && children[0].kind === "element" && children[0].block.lines.length === 1) {
    // The inlined line still represents the child element (deepest), so
    // attribute ownership to it — that's where target lookups should land.
    return { lines: [`${head} > ${children[0].block.lines[0]}`], owners: [children[0].block.owners[0] ?? el] };
  }

  const inner = concat(...children.map((c) => indent(c.block, 1)));
  return concat({ lines: [head], owners: [el] }, inner);
}

export interface PrettyResult {
  text: string;
  /** Per output line: the element it represents, or null when the line is a
   *  text run with no single owner. Same length as text.split("\n"). */
  owners: (Element | null)[];
}

export function renderPrettyWithOwners(doc: Document): PrettyResult {
  const root = doc.documentElement || doc.body;
  if (!root) return { text: "", owners: [] };
  const start = doc.body ?? root;
  const block = renderElement(start);
  return { text: block.lines.join("\n"), owners: block.owners };
}

export function renderPretty(doc: Document, _opts: { maxLineLen?: number } = {}): string {
  return renderPrettyWithOwners(doc).text;
}

/** Pretty-printed HTML serialization of the document, one tag per line.
 *  We don't try to be a full-fledged formatter — we just split the tree so
 *  that *each element* gets its own line. This keeps line-level diffs
 *  granular enough to be readable when used with `diff --html`.
 *
 *  Inline content (text nodes, <br>) stays on the same line as its parent
 *  open tag when it's the only child; otherwise text becomes its own line.
 *  Style/script bodies are emitted verbatim so we don't perturb the diff in
 *  ways that aren't real DOM changes. */
const VOID_HTML_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

const RAW_TEXT_TAGS = new Set(["script", "style", "noscript", "template"]);

export interface RenderHtmlOptions {
  /** when true, <style> bodies and <svg> subtrees are emitted verbatim.
   *  default false: collapse them to length-tagged placeholders so diffs
   *  stay readable. */
  raw?: boolean;
}

export function renderHtml(doc: Document, opts: RenderHtmlOptions = {}): string {
  const out: string[] = ["<!DOCTYPE html>"];
  const root = doc.documentElement;
  if (!root) return "";
  serializeElement(root, 0, out, !!opts.raw);
  return out.join("\n");
}

function serializeElement(el: Element, depth: number, out: string[], raw: boolean): void {
  const tag = (el.tagName || "").toLowerCase();
  // <noscript> is rendered fallback content for non-JS clients; in a recorded
  // session it's never executed and just adds noise. drop entirely unless raw.
  if (tag === "noscript" && !raw) return;
  const indent = "  ".repeat(depth);
  const attrs = attrsToString(el);
  if (VOID_HTML_TAGS.has(tag)) {
    out.push(`${indent}<${tag}${attrs}/>`);
    return;
  }
  // raw-text or no-children short-form
  if (RAW_TEXT_TAGS.has(tag)) {
    const inner = el.textContent ?? "";
    if (!inner.trim()) {
      out.push(`${indent}<${tag}${attrs}></${tag}>`);
      return;
    }
    if (tag === "style" && !raw) {
      // stylesheets are huge and rarely the subject of inspection; collapse
      // their body to a length-tagged placeholder so downstream diffs still
      // notice content changes without ballooning the output.
      out.push(`${indent}<${tag}${attrs}>/* ${inner.length} chars */</${tag}>`);
      return;
    }
    out.push(`${indent}<${tag}${attrs}>`);
    for (const line of inner.split("\n")) out.push(`${indent}  ${line}`);
    out.push(`${indent}</${tag}>`);
    return;
  }
  // collapse svg subtrees: their structure is rarely the user's target and
  // a single icon often spans dozens of <path>/<g> nodes. report element
  // count + serialized length so real changes still alter the placeholder.
  if (tag === "svg" && !raw) {
    const stats = svgStats(el);
    out.push(
      `${indent}<${tag}${attrs}><!-- ${stats.elements} elements, ${stats.chars} chars --></${tag}>`,
    );
    return;
  }
  const children = Array.from(el.childNodes);
  if (children.length === 0) {
    out.push(`${indent}<${tag}${attrs}></${tag}>`);
    return;
  }
  // single text-only child — keep on one line
  if (children.length === 1 && children[0].nodeType === 3) {
    const t = (children[0] as Text).data.replace(/\s+/g, " ").trim();
    out.push(`${indent}<${tag}${attrs}>${escapeText(t)}</${tag}>`);
    return;
  }
  out.push(`${indent}<${tag}${attrs}>`);
  for (const c of children) {
    if (c.nodeType === 3) {
      const t = (c as Text).data.replace(/\s+/g, " ").trim();
      if (t) out.push(`${"  ".repeat(depth + 1)}${escapeText(t)}`);
    } else if (c.nodeType === 1) {
      serializeElement(c as Element, depth + 1, out, raw);
    } else if (c.nodeType === 8) {
      out.push(`${"  ".repeat(depth + 1)}<!--${(c as Comment).data}-->`);
    }
  }
  out.push(`${indent}</${tag}>`);
}

function svgStats(el: Element): { elements: number; chars: number } {
  // length of the outerHTML-ish projection — cheap fingerprint that flips
  // whenever any attribute or text inside the svg changes.
  let elements = 0;
  let chars = 0;
  const walk = (n: Node) => {
    if (n.nodeType === 1) {
      elements++;
      const e = n as Element;
      chars += (e.tagName || "").length + 2;
      for (const a of Array.from(e.attributes)) {
        chars += a.name.length + a.value.length + 4;
      }
      for (const c of Array.from(e.childNodes)) walk(c);
    } else if (n.nodeType === 3) {
      chars += ((n as Text).data || "").length;
    }
  };
  walk(el);
  return { elements, chars };
}

function attrsToString(el: Element): string {
  const attrs = Array.from(el.attributes);
  if (!attrs.length) return "";
  return " " + attrs.map((a) => `${a.name}="${escapeAttr(a.value)}"`).join(" ");
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function escapeText(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
