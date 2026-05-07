# rrweb-cli

Agent-friendly CLI for parsing, listing, and diffing
[rrweb](https://www.rrweb.io/) session recordings (json files).

## What it does

Given an rrweb recording (an array of events, or `{ events: [...] }`):

- Reconstructs the DOM tree using the official `rrweb-snapshot` package on top
  of a `jsdom` Document, then applies each incremental mutation in order.
- After every event, formats the resulting DOM into a *readPretty* tree —
  a line-per-block, innerText-style rendering meant for diffing.
- Computes a unified-style diff between the readPretty tree before and after
  each event.

Because reconstructing the DOM for a long recording is expensive, large files
are served by a **per-file daemon** keyed by `<absolute path, size, mtime>`
hash; daemons self-destruct after **10 minutes of inactivity**.

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

## Install / build

```bash
npm install
npm run build
```

## Usage

```bash
# default: list events (drops MouseMove + drops empty-diff events,
# then merges consecutive same-name runs)
node dist/cli.js -f recording.json

# show every event (no merging, no diff filter)
node dist/cli.js -f recording.json list --all
node dist/cli.js -f recording.json list --mousemove

# filter (any explicit --id disables merging)
node dist/cli.js -f recording.json list -e Input,Click
node dist/cli.js -f recording.json list --time 1.0-5.0
node dist/cli.js -f recording.json list --id 9,12
node dist/cli.js -f recording.json list --id 9-16

# inspect a specific event
node dist/cli.js -f recording.json detail 9             # readPretty AFTER the event
node dist/cli.js -f recording.json detail 9 --before    # readPretty BEFORE the event
node dist/cli.js -f recording.json detail 9 --html      # innerHTML form
node dist/cli.js -f recording.json detail 9 --raw       # raw rrweb event json
node dist/cli.js -f recording.json diff 9               # full unified diff
node dist/cli.js -f recording.json diff 9-16            # range diff (before 9 → after 16)

# json output everywhere
node dist/cli.js -f recording.json --format json list

# daemon controls
node dist/cli.js daemon-clear                            # stop & cleanup
```

## List columns

| column | meaning |
| ------ | ------- |
| `id`   | 1-based event id (matches the input array index + 1) |
| `event`| rrweb event-type name. For `IncrementalSnapshot` it shows the source (`Mutation`, `Input`, `Scroll`, …); MouseInteraction shows the sub-type (`Click`, `Focus`, `Blur`, …). |
| `time` | seconds since the first event (`0.000s` is the first event) |
| `diff` | unified-style diff of the readPretty tree, **truncated to 5 body lines**. Use `diff <id>` to print the full diff. |

## Daemon details

- Threshold: 4 MB. Below it the CLI parses inline; at-or-above it auto-spawns
  a daemon for the file. (No flag — the choice is automatic.)
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
  index-build.ts  # walk events; build DOM, pretty trees, diffs
  dom.ts          # rrweb-snapshot rebuild + mutation/input applier
  pretty.ts       # readPretty + innerHTML rendering
  diff.ts         # LCS-based line diff
  filter.ts       # list / tree / diff handlers
  event-name.ts   # rrweb event-type → label
  text.ts         # text-mode rendering of responses
  types.ts        # shared types
```
