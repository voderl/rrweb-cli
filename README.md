# rrweb-cli

Agent-friendly CLI for parsing, listing, and diffing
[rrweb](https://www.rrweb.io/) session recordings (json files). Useful for
tracing what a user did and how the page changed in response, and pairs
naturally with [har-cli](https://github.com/voderl/har-cli) for end-to-end
webpage analysis — rrweb-cli covers DOM and user interactions, har-cli
covers the network side.

## Install

Requires Node.js ≥ 18.

```bash
# one-shot via npx (no install)
npx rrweb-cli -f recording.json

# or install globally and use the `rrweb-cli` binary
npm install -g rrweb-cli
```

## Example

A typical session: hand a recording to your coding agent and ask what the
user did. The agent drives `rrweb-cli` itself — `list` for an overview, then
`detail` / `diff` to zoom in.

> **You:** Analyze the user flow in `demo.json`.
>
> **Agent:** The user searched **`hello~`** on Google and browsed the
> results. Full path (~29s, 62 events):
>
> 1. `0.0s` — Loaded `https://www.google.com/`
> 2. `1.8s` — Clicked the search box (dropdown opened)
> 3. `5.7–8.7s` — Typed `h → he → hel → hell → hello → hello~`
> 4. `16.6s` — Submitted; results page loaded
> 5. `22.3s` — Re-clicked the search box, then dismissed the dropdown
> 6. `24.5–26.1s` — Scrolled through results (Wikipedia, Merriam-Webster…)

## Getting a recording

The simplest way to capture a session: install the official
[**rrweb Chrome extension**](https://chromewebstore.google.com/detail/rrweb/cipoifocpcgolejjlfbnnnoenhjpmbjp),
record a session, then extract its events from IndexedDB. The extension stores
each session under the `events` database; on the session detail page you can
download the json by pasting this into DevTools console:

```js
(async () => {
  const id = decodeURIComponent(location.hash.split('/session/')[1] || '');
  if (!id) throw new Error('no session id in url');

  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('events');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const rec = await new Promise((res, rej) => {
    const r = db.transaction('events').objectStore('events').get(id);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  if (!rec) throw new Error(`no record for key ${id}`);

  const blob = new Blob([JSON.stringify(rec.events)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `${id}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
})();
```

You'll get `<session-id>.json` in your Downloads folder — feed it to
`rrweb-cli` via `-f`.

Any rrweb json file works (an array of events or `{ events: [...] }`); the
extension is just one convenient source.

## Usage

The CLI is designed to be driven by a coding agent. Point your agent at a
recording file and it can list events, inspect any one in detail, or diff
the DOM around a specific moment.

```bash
# default: list events that have a readPretty diff or are a key gesture
# (Click / DblClick / ContextMenu); other no-diff events (MouseDown,
# MouseUp, Focus, Blur, Scroll, MouseMove, …) are filtered out, and
# adjacent same-name runs are merged.
rrweb-cli -f recording.json

# include everything except MouseMove (Mouse/Focus/Blur/Scroll all show up)
rrweb-cli -f recording.json list --all

# also include MouseMove
rrweb-cli -f recording.json list --all --mousemove

# filter (an explicit --id disables merging — exact rows back)
rrweb-cli -f recording.json list -e Input,Click
rrweb-cli -f recording.json list --time 1.0-5.0
rrweb-cli -f recording.json list --id 9,12
rrweb-cli -f recording.json list --id 9-16

# pagination (default: page 1, 50 rows/page)
rrweb-cli -f recording.json list -p 2 --page-size 100

# inspect a specific event
rrweb-cli -f recording.json detail 9             # readPretty AFTER the event
rrweb-cli -f recording.json detail 9 --before    # readPretty BEFORE the event
rrweb-cli -f recording.json detail 9 --html      # innerHTML (style/svg collapsed)
rrweb-cli -f recording.json detail 9 --raw-html  # innerHTML, style/svg verbatim
rrweb-cli -f recording.json detail 9 --raw       # raw rrweb event json

# unified diffs (default: readPretty)
rrweb-cli -f recording.json diff 9               # diff for one event
rrweb-cli -f recording.json diff 9-16            # range diff (before 9 → after 16)
rrweb-cli -f recording.json diff 9 --html        # diff the innerHTML form instead

# json output (list only — detail/diff are always text)
rrweb-cli -f recording.json list --format json

# daemon controls
rrweb-cli daemon-clear                           # stop & cleanup
```

## What it does

Given an rrweb recording (an array of events, or `{ events: [...] }`):

- Reconstructs the DOM tree using the official `rrweb-snapshot` package on top
  of a `jsdom` Document, then applies each incremental mutation in order.
- After every event, formats the resulting DOM into a *readPretty* tree —
  a hierarchical, innerText-leaning rendering that drops decorative wrappers
  but preserves semantic attributes (`role`, `aria-*`, `disabled`, `href`,
  form `placeholder` / `value`, …) and atomic tags (`img`, `svg`, …).
- Computes a unified-style diff between the readPretty tree before and after
  each event.
- For events that don't move the DOM but still address a node (Click, Focus,
  Scroll, …), produces a one-line locator pointing at the target's readPretty
  line (with the nearest rendered ancestor when readPretty folded the target).
- Folds noise: consecutive same-source events within a 1s gap merge into one
  row (`Mutation(×7)`); chains of locator events on the *same target* merge
  into `MouseDown+Focus+MouseUp+Click`.

Because reconstructing the DOM for a long recording is expensive, large files
are served by a **per-file daemon** keyed by `<absolute path, size, mtime>`
hash; daemons self-destruct after **10 minutes of inactivity**.


## List columns

| column | meaning |
| ------ | ------- |
| `id`   | 1-based event id (matches the input array index + 1). Merged rows show as a range `9-16`. |
| `event`| rrweb event-type name. For `IncrementalSnapshot` it shows the source (`Mutation`, `Input`, `Scroll`, …); MouseInteraction shows the sub-type (`Click`, `Focus`, `Blur`, …). Merged rows show `Mutation(×7)` for same-source runs and `MouseDown+Focus+MouseUp+Click` for same-target locator chains. |
| `time` | seconds since the first event (`0.000s` is the first event). Merged rows show a range `2.320-3.626s`. |
| `diff` | for the list preview, unified-diff context lines are stripped and only `+`/`-` lines are kept. When the change is ≤3 lines it's shown in full; otherwise it's truncated to ~3 lines with a `(+N more line(s); use \`diff <id>\` for the full diff)` hint. Locator rows (Click/Focus/…) instead show `→ line N: <readPretty rendering of the target>` and are never truncated. `FullSnapshot` rows show `use \`detail <id>\` for the full readPretty tree` since a unified diff against the prior state is rarely useful there. |

## Daemon details

- Threshold: 1 MB. Below it the CLI parses inline; at-or-above it auto-spawns
  a daemon for the file. If a daemon for the file is already running, every
  request is routed to it regardless of size. (No flag — the choice is
  automatic.)
- Cache key: `sha1(absPath + size + mtimeMs)` — editing the file picks up a
  new daemon automatically.
- Idle timeout: 10 minutes since the last request.
- Runtime files live under `$TMPDIR/rrweb-cli/<uid>/d-<hash>.{sock,pid,log}`.

## Project layout

```
src/
  cli.ts          # commander entry
  client.ts       # IPC client + daemon spawn/connect logic
  daemon.ts       # IPC server, idle timeout, request handler
  protocol.ts     # length-prefixed JSON over a unix socket
  version.ts      # file-version hashing + tmpdir paths
  index-build.ts  # walk events; build DOM, pretty trees, diffs, locators
  dom.ts          # rrweb-snapshot rebuild + mutation/input applier
  pretty.ts       # readPretty + innerHTML rendering (with line→element owners)
  diff.ts         # LCS-based line diff
  locator.ts      # `[Target]` locator diff for non-mutating events
  filter.ts       # list / detail / diff handlers + row merging
  event-name.ts   # rrweb event-type → label
  text.ts         # text-mode rendering of responses
  types.ts        # shared types
```
