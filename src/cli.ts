#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { clearAllDaemons, sendRequest } from "./client";
import { runDaemon } from "./daemon";
import { renderDetail, renderDiff, renderList } from "./text";
import {
  DetailResponse,
  DiffResponse,
  FilterOptions,
  ListResponse,
} from "./types";

type Format = "text" | "json";

function parseFormat(input: string | undefined): Format {
  if (!input) return "text";
  const v = input.toLowerCase();
  if (v === "text" || v === "json") return v;
  throw new Error(`unknown --format: "${input}". Allowed: text, json`);
}

function parseTimeRange(input: string | undefined): { startSec?: number; endSec?: number } {
  if (!input) return {};
  const m = input.match(/^\s*(-?\d+(?:\.\d+)?)?\s*-\s*(-?\d+(?:\.\d+)?)?\s*$/);
  if (!m) {
    const single = parseFloat(input);
    if (!Number.isNaN(single)) return { startSec: single };
    throw new Error(`invalid --time: "${input}". Use formats like "1.0-3.5", "2-", "-5"`);
  }
  return {
    startSec: m[1] !== undefined ? parseFloat(m[1]) : undefined,
    endSec: m[2] !== undefined ? parseFloat(m[2]) : undefined,
  };
}

/** Accept "1", "1,2,3", "9-16", "1,5-8,12". Each id must be a positive int. */
function parseIds(input: string | undefined): number[] | undefined {
  if (!input) return undefined;
  const parts = input.split(",").map((s) => s.trim()).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (Number.isNaN(a) || Number.isNaN(b) || a <= 0 || b <= 0) {
        throw new Error(`invalid --id range "${p}": both ends must be positive integers`);
      }
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let i = lo; i <= hi; i++) if (!out.includes(i)) out.push(i);
      continue;
    }
    const n = parseInt(p, 10);
    if (Number.isNaN(n) || n <= 0 || !/^\d+$/.test(p)) {
      throw new Error(
        `invalid --id "${p}". expected positive integer, list (1,2,3) or range (9-16).`,
      );
    }
    if (!out.includes(n)) out.push(n);
  }
  return out.length > 0 ? out : undefined;
}

/** Parse a single id or "a-b" range argument for tree/diff commands. */
function parseIdRange(input: string): { startId: number; endId: number } {
  const trimmed = input.trim();
  const m = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (Number.isNaN(a) || Number.isNaN(b) || a <= 0 || b <= 0) {
      throw new Error(`invalid id range "${input}": both ends must be positive integers`);
    }
    return { startId: Math.min(a, b), endId: Math.max(a, b) };
  }
  const n = parseInt(trimmed, 10);
  if (Number.isNaN(n) || n <= 0 || !/^\d+$/.test(trimmed)) {
    throw new Error(`invalid id "${input}". expected positive integer or range like "9-16".`);
  }
  return { startId: n, endId: n };
}

function printJson(resp: { ok: boolean; data?: unknown; error?: string }) {
  if (resp.ok) {
    process.stdout.write(JSON.stringify(resp.data, null, 2) + "\n");
  } else {
    process.stdout.write(JSON.stringify({ error: resp.error }, null, 2) + "\n");
    process.exitCode = 1;
  }
}

function printText(text: string) {
  process.stdout.write(text + "\n");
}

function printError(format: Format, msg: string) {
  if (format === "json") {
    process.stdout.write(JSON.stringify({ error: msg }, null, 2) + "\n");
  } else {
    process.stderr.write(`error: ${msg}\n`);
  }
  process.exitCode = 1;
}

function buildListSummary(filter: FilterOptions): string {
  const parts: string[] = [];
  if (filter.ids && filter.ids.length) parts.push(`id=${filter.ids.join(",")}`);
  if (filter.event) parts.push(`event~${filter.event}`);
  if (filter.startSec != null || filter.endSec != null) {
    parts.push(`time=${filter.startSec ?? ""}-${filter.endSec ?? ""}s`);
  }
  if (filter.includeMouseMove) parts.push("mousemove=on");
  if (filter.showNoDiff) parts.push("all=on");
  return parts.join("  ");
}

interface RootOpts {
  file?: string;
}

function requireFile(file: string | undefined): string {
  if (!file) {
    throw new Error(
      "missing --file <path>. Usage: rrweb-cli -f <recording.json> [list|tree <id>|diff <id>]",
    );
  }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    throw new Error(`file not found: ${abs}`);
  }
  return abs;
}

async function main() {
  const program = new Command();
  program
    .name("rrweb-cli")
    .description("Agent-friendly CLI for parsing/listing/diffing rrweb session recordings.")
    .version("0.1.0")
    .option("-f, --file <path>", "rrweb recording (json) file path");

  // ---- list (default)
  const listCmd = program
    .command("list", { isDefault: true })
    .description(
      "list events. by default: drop events with empty diff, then merge consecutive same-name events.",
    )
    .option("--id <ids>", "filter by event id; accepts '1', '1,2,3', '9-16', '1,5-8,12'. disables merging.")
    .option("-e, --event <terms>", "filter by event-name substring (comma-separated, OR)")
    .option("--time <range>", "time range in seconds, e.g. '1.0-3.5', '2-', '-5'")
    .option("--mousemove", "include MouseMove/TouchMove/Drag events", false)
    .option("--all", "list every event except MouseMove (use --mousemove to include MouseMove too)", false)
    .option("--format <fmt>", "output format: text (default) or json", "text")
    .option("-p, --page <n>", "page number (default 1)", (v) => parseInt(v, 10))
    .option("--page-size <n>", "page size (default 50)", (v) => parseInt(v, 10));
  listCmd.action(async (opts, command: Command) => {
    const root = command.parent!.opts<RootOpts>();
    const format = parseFormat(opts.format);
    try {
      const file = requireFile(root.file);
      const range = parseTimeRange(opts.time);
      const filter: FilterOptions = {
        ids: parseIds(opts.id),
        event: opts.event,
        startSec: range.startSec,
        endSec: range.endSec,
        includeMouseMove: !!opts.mousemove,
        showNoDiff: !!opts.all,
        page: opts.page,
        pageSize: opts.pageSize,
      };
      const resp = await sendRequest(file, { kind: "list", filter });
      if (!resp.ok) { printError(format, resp.error); return; }
      if (format === "json") printJson(resp);
      else printText(renderList(resp.data as ListResponse, buildListSummary(filter)));
    } catch (e) {
      printError(format, (e as Error).message);
    }
  });

  // ---- detail <id>
  program
    .command("detail <id>")
    .description(
      "show the state for a single event. defaults to readPretty after the event was applied.",
    )
    .option("--html", "show the innerHTML form (style/svg collapsed) instead of readPretty")
    .option("--raw-html", "like --html but keep <style> bodies and <svg> subtrees verbatim")
    .option("--raw", "show the raw rrweb event json (overrides --html/--raw-html)")
    .option("--before", "show the state BEFORE this event was applied (default: after)")
    .action(async (idStr: string, opts, command: Command) => {
      const root = command.parent!.opts<RootOpts>();
      try {
        const file = requireFile(root.file);
        const id = parseInt(idStr, 10);
        if (Number.isNaN(id) || id <= 0 || !/^\d+$/.test(idStr.trim())) {
          printError("text", `invalid id: "${idStr}". expected a positive integer.`);
          return;
        }
        const fmt: "pretty" | "html" | "raw-html" | "raw" = opts.raw
          ? "raw"
          : opts.rawHtml
            ? "raw-html"
            : opts.html
              ? "html"
              : "pretty";
        const side: "before" | "after" = opts.before ? "before" : "after";
        const resp = await sendRequest(file, { kind: "detail", id, format: fmt, side });
        if (!resp.ok) { printError("text", resp.error); return; }
        printText(renderDetail(resp.data as DetailResponse));
      } catch (e) {
        printError("text", (e as Error).message);
      }
    });

  // ---- diff <id>
  program
    .command("diff <id>")
    .description("show the full readPretty unified diff for an event (or id range like 9-16)")
    .option("--html", "diff the raw innerHTML instead of the readPretty tree")
    .action(async (idStr: string, opts, command: Command) => {
      const root = command.parent!.opts<RootOpts>();
      try {
        const file = requireFile(root.file);
        let startId: number, endId: number;
        try {
          ({ startId, endId } = parseIdRange(idStr));
        } catch (e) {
          printError("text", (e as Error).message);
          return;
        }
        const diffFormat: "pretty" | "html" = opts.html ? "html" : "pretty";
        const resp = await sendRequest(file, { kind: "diff", id: startId, endId, format: diffFormat });
        if (!resp.ok) { printError("text", resp.error); return; }
        printText(renderDiff(resp.data as DiffResponse));
      } catch (e) {
        printError("text", (e as Error).message);
      }
    });

  // ---- daemon-clear
  program
    .command("daemon-clear")
    .description("stop all running daemons and clear cached socket/pid/log files")
    .action(async () => {
      const report = await clearAllDaemons();
      printText(
        `found ${report.found} daemon(s) · stopped ${report.stopped} · removed ${report.removed_files} file(s)` +
          (report.errors.length > 0 ? "\n\nerrors:\n  " + report.errors.join("\n  ") : ""),
      );
    });

  // ---- internal: spawn-as-daemon entry
  if (process.argv[2] === "__daemon__") {
    const file = process.argv[3];
    if (!file) {
      process.stderr.write("daemon: missing file path\n");
      process.exit(1);
    }
    runDaemon(file);
    return;
  }

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  process.stderr.write(`rrweb-cli error: ${err.message ?? err}\n`);
  process.exit(1);
});
