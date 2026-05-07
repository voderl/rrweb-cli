import * as fs from "node:fs";
import * as net from "node:net";
import { buildIndex, loadEventsFromFile, RRWebIndex } from "./index-build";
import { getDetail, getDiff, listEvents } from "./filter";
import { readMessage, writeMessage } from "./protocol";
import { DaemonRequest, DaemonResponse } from "./types";
import {
  computeVersion,
  pidPathFor,
  socketPathFor,
  FileVersion,
  logPathFor,
} from "./version";

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

interface DaemonState {
  version: FileVersion;
  index: RRWebIndex;
  lastActivity: number;
  idleTimer: NodeJS.Timeout | null;
  server: net.Server;
}

function loadIndex(filePath: string): RRWebIndex {
  const events = loadEventsFromFile(filePath);
  return buildIndex(events);
}

function resetIdleTimer(state: DaemonState) {
  state.lastActivity = Date.now();
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    shutdown(state, "idle-timeout");
  }, IDLE_TIMEOUT_MS);
}

function shutdown(state: DaemonState, reason: string) {
  try {
    state.server.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }
  setTimeout(() => process.exit(0), 1000).unref();
  process.stderr.write(`daemon shutting down: ${reason}\n`);
}

function handle(state: DaemonState, req: DaemonRequest): DaemonResponse {
  try {
    switch (req.kind) {
      case "ping":
        return { ok: true, data: { alive: true, hash: state.version.hash } };
      case "shutdown":
        setTimeout(() => shutdown(state, "client-requested"), 10).unref();
        return { ok: true, data: { stopping: true } };
      case "list":
        return { ok: true, data: listEvents(state.index, req.filter) };
      case "detail":
        return { ok: true, data: getDetail(state.index, req.id, req.format, req.side) };
      case "diff":
        return { ok: true, data: getDiff(state.index, req.id, req.endId, req.format) };
      default:
        return { ok: false, error: `unknown request kind` };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function runDaemon(filePath: string) {
  const version = computeVersion(filePath);
  const sockPath = socketPathFor(version);
  const pidPath = pidPathFor(version);

  try {
    fs.unlinkSync(sockPath);
  } catch {
    /* ignore */
  }

  const index = loadIndex(filePath);
  const server = net.createServer();
  const state: DaemonState = {
    version,
    index,
    lastActivity: Date.now(),
    idleTimer: null,
    server,
  };

  server.on("connection", (socket) => {
    socket.on("error", () => socket.destroy());
    (async () => {
      try {
        const reqRaw = (await readMessage(socket)) as DaemonRequest;
        resetIdleTimer(state);
        const resp = handle(state, reqRaw);
        await writeMessage(socket, resp);
      } catch (e) {
        try {
          await writeMessage(socket, { ok: false, error: (e as Error).message });
        } catch {
          /* ignore */
        }
      } finally {
        socket.end();
      }
    })();
  });

  server.listen(sockPath, () => {
    fs.writeFileSync(pidPath, String(process.pid));
    resetIdleTimer(state);
    process.stderr.write(
      `rrweb-cli daemon listening: file=${version.filePath} hash=${version.hash} pid=${process.pid}\n`,
    );
  });

  const cleanup = () => {
    try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => shutdown(state, "SIGINT"));
  process.on("SIGTERM", () => shutdown(state, "SIGTERM"));
}

export { IDLE_TIMEOUT_MS, logPathFor };
