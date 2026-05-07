import { DetailResponse, DiffResponse, ListResponse } from "./types";

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  if (s.length >= n) return s;
  return " ".repeat(n - s.length) + s;
}

export function renderList(resp: ListResponse, summary: string): string {
  const out: string[] = [];
  if (summary) out.push(summary);
  out.push(`total=${resp.total} shown=${resp.shown} page=${resp.page}/${Math.max(1, Math.ceil(resp.total / resp.pageSize))}`);
  if (resp.entries.length === 0) {
    out.push("(no events match)");
    return out.join("\n");
  }

  const idStr = (e: typeof resp.entries[number]) =>
    e.endId != null && e.endId !== e.id ? `${e.id}-${e.endId}` : String(e.id);
  const timeStr = (e: typeof resp.entries[number]) =>
    e.endTime != null && e.endTime !== e.time
      ? `${e.time.toFixed(3)}-${e.endTime.toFixed(3)}s`
      : `${e.time.toFixed(3)}s`;

  const idW = Math.max(2, ...resp.entries.map((e) => idStr(e).length));
  const evW = Math.max(5, ...resp.entries.map((e) => e.event.length));
  const tW = Math.max(7, ...resp.entries.map((e) => timeStr(e).length));

  out.push("");
  out.push(
    `${pad("id", idW)}  ${pad("event", evW)}  ${pad("time", tW)}  diff`,
  );
  out.push(`${"-".repeat(idW)}  ${"-".repeat(evW)}  ${"-".repeat(tW)}  ${"-".repeat(40)}`);
  for (const e of resp.entries) {
    const idCol = pad(idStr(e), idW);
    const evCol = pad(e.event, evW);
    const tCol = pad(timeStr(e), tW);
    if (!e.diffPreview) {
      out.push(`${idCol}  ${evCol}  ${tCol}  (no diff)`);
      continue;
    }
    const previewLines = e.diffPreview.split("\n");
    const headPad = `${idCol}  ${evCol}  ${tCol}  `;
    const cont = " ".repeat(headPad.length);
    out.push(`${headPad}${previewLines[0]}`);
    for (let i = 1; i < previewLines.length; i++) {
      out.push(`${cont}${previewLines[i]}`);
    }
    if (e.diffPreviewDropped > 0) {
      const arg = e.endId != null && e.endId !== e.id ? `${e.id}-${e.endId}` : String(e.id);
      out.push(`${cont}… (+${e.diffPreviewDropped} more line(s); use \`diff ${arg}\` for the full diff)`);
    }
  }
  return out.join("\n");
}

export function renderDetail(resp: DetailResponse): string {
  const head = `id=${resp.id}  event=${resp.event}  time=${resp.time.toFixed(3)}s  format=${resp.format}  side=${resp.side}`;
  return `${head}\n${resp.content || "(empty)"}`;
}

export function renderDiff(resp: DiffResponse): string {
  return resp.diff || "(no diff)";
}
