# Flow Connector extension

Licensed under the MIT License by MaxOut AI. You may use, modify, and redistribute this code if you keep this copyright notice and the MIT license terms.

Unpacked Manifest V3 extension. It drives the open `https://flow.google.com` tab from jobs the local CLI submits.

## Load unpacked

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this folder:

   `/Users/ayyaz/Documents/MyCreatedSkills/flowai-automation/extension`

4. Open `https://flow.google.com` and sign in. Leave that tab visible (not minimised). A narrow window hides Characters and Customize performance; maximise it before character or voice work.
5. Start the bridge with the Flow Connector CLI (`flow-auto`). It listens on `127.0.0.1:8791`.
6. Reload the Flow tab once after the first load so the content script is on the page. The service worker also injects it if the tab is already open.

Clicking the toolbar icon opens this page in the Chrome side panel. The first screen is Setup, with the agent prompt to copy. Status is the second tab and shows whether the socket is up and whether the Flow tab is visible.

## How it connects

The service worker runs the subscription gate below before it opens the socket. The CLI uses HTTP (`POST /jobs`, `GET /status`, and the other routes in the bridge). The extension channel is not HTTP. The bridge accepts an extension only on:

`ws://127.0.0.1:8791/ws`

The socket Origin has to be `chrome-extension://…`. Any other Origin is rejected.

First messages:

1. Bridge sends `{ "t": "bridge.hello", "bridgeVersion": "<version>" }`.
2. Extension sends `ext.hello` with `site: "flow"`, `plan: "free"`, `browser`, `flowTab`, and `flowVisible`.
3. Extension sends `ext.status` with `plan: "free"` and `dailyLimit` set to `Number.MAX_SAFE_INTEGER` (a finite stand-in for “no cap”; `Infinity` would become `null` and fail the bridge schema). `grokVisible` is whether the Flow tab is the active tab in a window that is not minimised. `flowLayout` is `wide` or `narrow`. `flowAccess` is `ok` or `blocked`.
4. The extension sends `ext.heartbeat` about every 20 seconds and reconnects if the socket drops. A close code `4001` means another install holds the slot; this one waits 30 seconds before trying again.

Input files are the HTTP part. On `job.submit`, each `inputFiles[].token` (and any `inputImages` entry with `source: "bridge-token"`) is fetched with:

`GET http://127.0.0.1:8791/files/<token>`

`job.accepted`, `job.progress`, `job.result`, and `job.failed` go back on the same socket. Progress stages are `acquiring-tab`, `preparing-page`, `applying-mode`, `applying-settings`, `attaching-images`, `entering-prompt`, `submitting`, `generating`, `collecting-results`, and `downloading`. A result file is `{ path, kind }` with `kind` of `image` or `video`. `path` is relative to Downloads, shaped like `flow-auto/1 - <label>.png` (the `--folder` value is used when the job sends one). `job.cancel`, `queue.stop`, `queue.clear`, and `ext.reload` are handled. `status.query`, `healthcheck.run`, `logs.query`, and `dom.query` are answered too.

The reported extension version is `1.2.4` because the bridge refuses more than three ingredients unless the connected extension is at least that version. This build passes every supplied file through to the page.

## Subscription gate

Before `ws://127.0.0.1:8791/ws` and before `ext.hello`, the service worker fetches `https://www.youtube.com/channel/UCf81rjZnBT9mo_PCXds62BQ` with `credentials: "include"`. This is not the official YouTube Data API, and there is no sign-in screen. The browser may attach existing `youtube.com` cookies. The extension does not read cookie values.

It parses `ytInitialData` and `ytcfg`. A logged-out page is inconclusive. Logged-out signals seen on a real response from that URL (no Google session) were `ytcfg` `"LOGGED_IN": false`, `responseContext.mainAppWebResponseContext.loggedOut: true`, and tracking params `logged_in` / `yt_li` of `"0"`. That same response had no `subscribed` field. The header control was a `buttonViewModel` whose tap opens a `signInEndpoint` (“Sign in to subscribe to this channel”), which is not treated as “not subscribed”.

A result counts as subscribed only when the page is not logged out and a header subscribe control, or a control whose `channelId` is this id, has `subscribed: true`, or a subscribe-button `state` containing `SUBSCRIBED` (and not `UNSUBSCRIBED` / `NOT_SUBSCRIBED`). It counts as not subscribed only when the page is clearly logged in (`LOGGED_IN: true`, `loggedOut: false`, or `logged_in` / `yt_li` of `"1"`, with no conflicting logged-out flag) and that control has `subscribed: false` or an unsubscribed state. A `subscribed: false` on a sign-in modal does not count. Those logged-in fields were not present on the response fetched while writing this. If the HTML has no flag, the worker sends one `POST https://www.youtube.com/youtubei/v1/browse` for browse id `UCf81rjZnBT9mo_PCXds62BQ`, using the client version and API key embedded in that HTML, and reads the same fields. A cookieless browse of that id returned the same logged-out shape, still with no `subscribed` field.

The socket stays closed only for a clear “not subscribed”. The popup then says “Subscribe to the channel to use this extension.” and shows the channel URL. Anything else (logged out, consent wall, non-200, missing flag, network error, conflicting login flags) falls open and the socket connects as before. Bridge messages are unchanged once the socket is open.

A clear subscribed or not-subscribed result is stored in `chrome.storage.session` under `ytSubGate` for the browser session only. Later service-worker wakes reuse that clear result and do not request YouTube again. An inconclusive result is not stored, so the next worker start tries again. Nothing about this check is written to `chrome.storage.local`. Browser startup (`onStartup`) and install/update (`onInstalled`) clear any session value and check again. There is no prompt.

A service-worker fetch often gets the same logged-out or consent HTML, because the request Origin is the extension and YouTube may ignore the cookies. The only channel response inspected here was that logged-out page, so the same response falls open every time. No logged-in body was checked. If YouTube does not return personalized HTML to an extension fetch, expect detection well under half the time, possibly near zero. This check is not reliable.

## Flow modes

Every mode the bridge can send has a path. Each one looks for the controls Google documents (prompt box, Image / Video / Video Frames / Video Ingredients, settings chips, Add or a file input, Generate, Approve, Download, Characters, Extend, Rename). If that control is not on the page, the job ends with `job.failed` and the name of the missing control.

These were not run against a signed-in Flow tab, and Flow changes its DOM often, so treat them as best-effort:

| Mode | What it drives |
|---|---|
| `flow-text-to-image` | Image mode, settings, prompt, Generate, download |
| `flow-image-to-image` | Image mode plus uploaded files or named assets |
| `flow-text-to-video` | Video mode, duration, resolution (`480p` clicks Flow's 360p chip), Generate, download |
| `flow-frame-to-video` | Video Frames, start frame, optional end frame |
| `flow-ingredients-to-video` | Video Ingredients and the reference files or assets |
| `flow-video-to-video` | Same attach path as ingredients, for one clip. Best-effort: Flow only edits a 3–10s Omni Flash clip |
| `flow-extend-video` | Extend on `/project/<id>/edit/<clip>` only. Fails with a reason when Extend is missing or disabled |
| `flow-create-character` | Characters, portrait prompt, name, voice, body. Exact name already in the list finishes with the “already exists” warning and does not generate |
| `flow-set-voice` | The open character, or `--character`. Select a voice / Save New Voice / Add to Character |
| `flow-rename-asset` | Asset label, its menu, Rename. Fails with `no Rename item in its menu` or `never showed a text field` |
| `flow-upload-assets` | One file input, in groups of 50, then waits until the filenames are listed |

`flow-create-character` and `flow-set-voice` refuse `--voice-style` when the window is narrow. Jobs run one at a time on the open tab.
