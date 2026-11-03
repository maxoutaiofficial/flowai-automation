/**
 * Flow Connector service worker.
 *
 * The CLI talks to the bridge over HTTP. The extension channel is the
 * WebSocket the bridge opens at ws://127.0.0.1:8791/ws. A YouTube
 * subscription check runs before that socket opens. File bytes are the
 * one HTTP call this side makes to the bridge: GET /files/<token>.
 */

const BRIDGE_WS = "ws://127.0.0.1:8791/ws";
const FILE_BASE = "http://127.0.0.1:8791/files/";
const EXT_VERSION = "1.2.4";
const CHANNEL_ID = "UCf81rjZnBT9mo_PCXds62BQ";
const CHANNEL_URL = "https://www.youtube.com/channel/UCf81rjZnBT9mo_PCXds62BQ";
const SESSION_GATE_KEY = "ytSubGate";
const UNLIMITED_DAILY = Number.MAX_SAFE_INTEGER;
const STAGES = new Set([
  "acquiring-tab",
  "preparing-page",
  "applying-mode",
  "applying-settings",
  "attaching-images",
  "entering-prompt",
  "submitting",
  "generating",
  "collecting-results",
  "downloading"
]);

let socket = null;
let helloReady = false;
let retryMs = 1000;
let reconnectTimer = null;
let connectTimer = null;
let statusTimer = null;
let lastError = "";
let lastWarning = null;
const logs = [];
const queue = [];
let pumping = false;
let current = null;
let booted = false;
let subGate = null;
let gatePromise = null;
let gateEpoch = 0;

let arm = null;
let apiDepth = 0;

function log(level, scope, message) {
  logs.push({ ts: Date.now(), level, scope, message: String(message) });
  if (logs.length > 200) logs.shift();
}

function browserName() {
  const ua = navigator.userAgent || "";
  if (/Edg\//.test(ua)) return "edge";
  if (/Chrome\//.test(ua)) return "chrome";
  return "other";
}

function wsSend(msg) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(msg));
  return true;
}

function scheduleReconnect(ms) {
  if (subGate === "unsubscribed" || subGate == null) return;
  const wait = ms == null ? retryMs : ms;
  retryMs = Math.min(30000, Math.max(1000, retryMs * 2));
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, wait);
}

function connect() {
  if (subGate === "unsubscribed" || subGate == null) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  helloReady = false;
  let ws;
  try {
    ws = new WebSocket(BRIDGE_WS);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    log("error", "bridge", lastError);
    scheduleReconnect();
    return;
  }
  socket = ws;
  let chain = Promise.resolve();
  ws.addEventListener("open", () => {
    if (socket !== ws) return;
    retryMs = 1000;
    lastError = "";
    log("info", "bridge", "socket open");
  });
  ws.addEventListener("message", (ev) => {
    if (socket !== ws) return;
    chain = chain.then(() => handleMessage(String(ev.data))).catch((err) => {
      log("error", "bridge", err instanceof Error ? err.message : String(err));
    });
  });
  ws.addEventListener("close", (ev) => {
    if (socket === ws) socket = null;
    helloReady = false;
    const standby = ev.code === 4001;
    log("info", "bridge", standby ? "put on standby" : `socket closed (${ev.code})`);
    scheduleReconnect(standby ? 30000 : null);
  });
  ws.addEventListener("error", () => {
    lastError = "cannot reach ws://127.0.0.1:8791/ws";
    log("error", "bridge", lastError);
  });
}

async function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    log("warn", "bridge", "ignored a non-JSON message");
    return;
  }
  switch (msg.t) {
    case "bridge.hello":
      await sendHello();
      helloReady = true;
      void pump();
      break;
    case "status.query":
      await sendStatus();
      break;
    case "job.submit":
      enqueue(msg);
      break;
    case "job.cancel":
      cancelJob(msg.jobId);
      break;
    case "queue.stop":
      stopQueue();
      break;
    case "queue.clear":
      await clearHistory();
      break;
    case "ext.reload":
      log("info", "bridge", "reload requested");
      chrome.runtime.reload();
      break;
    case "healthcheck.run":
      await replyHealthcheck();
      break;
    case "logs.query":
      await replyLogs();
      break;
    case "dom.query":
      await replyDom(msg);
      break;
    default:
      log("info", "bridge", `unhandled ${msg.t || "message"}`);
  }
}

async function sendHello() {
  const snap = await collectPageState().catch(() => emptySnap());
  const runningJobIds = current?.jobId ? [current.jobId] : [];
  wsSend({
    t: "ext.hello",
    extVersion: EXT_VERSION,
    loggedIn: snap.loggedIn,
    plan: "free",
    site: "flow",
    browser: browserName(),
    runningJobIds,
    flowTab: snap.flowTab,
    flowVisible: snap.flowVisible
  });
  await sendStatus(snap);
}

async function sendStatus(existing) {
  const snap = existing || await collectPageState().catch(() => emptySnap());
  wsSend({
    t: "ext.status",
    loggedIn: snap.loggedIn,
    plan: "free",
    usedToday: 0,
    dailyLimit: UNLIMITED_DAILY,
    activeJobs: current ? 1 : 0,
    grokVisible: snap.grokVisible,
    flowLayout: snap.flowLayout,
    flowAccess: snap.flowAccess,
    pausedReason: null,
    cooldownUntil: null,
    lastWarning,
    browser: browserName()
  });
}

function emptySnap() {
  return {
    loggedIn: false,
    flowTab: false,
    flowVisible: false,
    grokVisible: null,
    flowLayout: null,
    flowAccess: null
  };
}

async function findFlowTabs() {
  return chrome.tabs.query({ url: "https://flow.google.com/*" });
}

async function findFlowTab() {
  const tabs = await findFlowTabs();
  if (!tabs.length) return null;
  const focused = await chrome.windows.getLastFocused().catch(() => null);
  return (
    tabs.find((tab) => tab.active && focused && tab.windowId === focused.id) ||
    tabs.find((tab) => tab.active) ||
    tabs[0]
  );
}

async function pingTab(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "ping" });
  } catch {
    return null;
  }
}

async function ensureContent(tabId) {
  const first = await pingTab(tabId);
  if (first?.ok) return first;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (err) {
    log("warn", "tab", err instanceof Error ? err.message : String(err));
    return null;
  }
  return pingTab(tabId);
}

async function collectPageState() {
  const tab = await findFlowTab();
  if (!tab) return emptySnap();
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  const minimized = !win || win.state === "minimized";
  let probe = await pingTab(tab.id);
  let flowAccess = "ok";
  if (!probe?.ok) {
    probe = await ensureContent(tab.id);
    if (!probe?.ok) flowAccess = "blocked";
  }
  const pageVisible = probe?.visible !== false;
  const grokVisible = !!(tab.active && !minimized && pageVisible && probe?.ok);
  return {
    loggedIn: probe?.ok ? !!probe.loggedIn : true,
    flowTab: true,
    flowVisible: grokVisible,
    grokVisible: probe?.ok ? grokVisible : minimized || !tab.active ? false : null,
    flowLayout: probe?.flowLayout || null,
    flowAccess
  };
}

function scheduleStatusPush() {
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusTimer = null;
    if (helloReady) void sendStatus();
  }, 250);
}

function enqueue(msg) {
  if (!msg?.jobId || !msg.job) return;
  if (current?.jobId === msg.jobId) return;
  if (queue.some((item) => item.jobId === msg.jobId)) return;
  queue.push({ jobId: msg.jobId, job: msg.job, inputFiles: msg.inputFiles || [] });
  void persistQueue();
  void pump();
}

async function persistQueue() {
  try {
    const pending = [];
    if (current?.jobId) pending.push({ jobId: current.jobId, job: current.job, inputFiles: current.inputFiles || [] });
    for (const item of queue) pending.push({ jobId: item.jobId, job: item.job, inputFiles: item.inputFiles || [] });
    const seen = new Set();
    await chrome.storage.session.set({
      queue: pending.filter((item) => {
        if (!item?.jobId || seen.has(item.jobId)) return false;
        seen.add(item.jobId);
        return true;
      })
    });
  } catch (err) {
    log("warn", "queue", err instanceof Error ? err.message : String(err));
  }
}

async function restoreQueue() {
  try {
    const stored = await chrome.storage.session.get("queue");
    const saved = stored.queue;
    if (!Array.isArray(saved)) return;
    for (const item of saved) enqueue(item);
  } catch (err) {
    log("warn", "queue", err instanceof Error ? err.message : String(err));
  }
}

async function remember(entry) {
  try {
    const stored = await chrome.storage.local.get("flowHistory");
    const history = Array.isArray(stored.flowHistory) ? stored.flowHistory : [];
    history.push(entry);
    await chrome.storage.local.set({ flowHistory: history.slice(-200) });
  } catch (err) {
    log("warn", "history", err instanceof Error ? err.message : String(err));
  }
}

async function clearHistory() {
  try {
    const stored = await chrome.storage.local.get("flowHistory");
    const history = Array.isArray(stored.flowHistory) ? stored.flowHistory : [];
    const keep = history.filter((item) => item.status !== "done" && item.status !== "failed" && item.status !== "cancelled");
    await chrome.storage.local.set({ flowHistory: keep });
    log("info", "queue", "cleared finished history");
  } catch (err) {
    log("warn", "history", err instanceof Error ? err.message : String(err));
  }
}

function cancelJob(jobId) {
  if (!jobId) return;
  const index = queue.findIndex((item) => item.jobId === jobId);
  if (index >= 0) queue.splice(index, 1);
  if (current?.jobId === jobId) current.abort();
  void persistQueue();
  log("info", "job", `cancel ${jobId}`);
}

function stopQueue() {
  queue.length = 0;
  if (current) current.abort();
  void persistQueue();
  log("info", "queue", "stop");
}

function progress(jobId, stage, message, pct) {
  if (!STAGES.has(stage)) return;
  const body = { t: "job.progress", jobId, stage };
  if (message) body.message = message;
  if (typeof pct === "number") body.pct = pct;
  wsSend(body);
}

function failJob(jobId, reason, retryable) {
  wsSend({
    t: "job.failed",
    jobId,
    reason: reason || "the job failed",
    retryable: !!retryable
  });
  void remember({ id: jobId, status: "failed", error: reason, at: Date.now() });
  log("error", "job", `${jobId} ${reason}`);
}

function finishJob(jobId, files, warning) {
  const body = { t: "job.result", jobId, files: files || [] };
  if (warning) body.warning = warning;
  wsSend(body);
  void remember({ id: jobId, status: "done", files: body.files, at: Date.now() });
  log("info", "job", `${jobId} done (${body.files.length} file(s))`);
}

async function pump() {
  if (pumping || !helloReady) return;
  pumping = true;
  try {
    while (queue.length) {
      const item = queue.shift();
      await runJob(item);
    }
  } finally {
    pumping = false;
    if (queue.length && helloReady) void pump();
  }
}

function fileList(msg) {
  const files = [];
  const seen = new Set();
  for (const file of msg.inputFiles || []) {
    if (!file?.token || seen.has(file.token)) continue;
    seen.add(file.token);
    files.push(file);
  }
  for (const image of msg.job?.inputImages || []) {
    if (image?.source === "bridge-token" && image.id && !seen.has(image.id)) {
      seen.add(image.id);
      files.push({ token: image.id, name: image.name, mime: image.mime, size: 0 });
    }
  }
  return files;
}

async function fetchToken(meta) {
  const res = await fetch(FILE_BASE + meta.token);
  if (!res.ok) {
    throw new Error(`GET /files/${meta.token} returned ${res.status}`);
  }
  const bytes = await res.arrayBuffer();
  return {
    name: meta.name || "upload.bin",
    mime: meta.mime || res.headers.get("content-type") || "application/octet-stream",
    bytes
  };
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x2000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
  }
  return btoa(binary);
}

function watchdogMs(job) {
  const mode = job?.mode || "";
  const beats = Math.max(1, job?.params?.extendSteps?.length || job?.params?.autoExtendCount || 1);
  if (mode === "flow-extend-video") return Math.min(beats, 8) * 12 * 60 * 1000;
  if (/rename-asset|upload-assets|set-voice/.test(mode)) return 3 * 60 * 1000;
  if (/video|frame|ingredient/.test(mode)) return 14 * 60 * 1000;
  if (mode === "flow-create-character") return 8 * 60 * 1000;
  return 5 * 60 * 1000;
}

async function focusTab(tab) {
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (win.state === "minimized") {
      await chrome.windows.update(tab.windowId, { state: "normal", focused: true });
    }
    await chrome.tabs.update(tab.id, { active: true });
  } catch (err) {
    log("warn", "tab", err instanceof Error ? err.message : String(err));
  }
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("the Flow tab did not finish loading"));
    }, timeoutMs);
    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function runJob(item) {
  const { jobId, job } = item;
  const abort = new AbortController();
  current = { jobId, job, inputFiles: item.inputFiles, abort, cancelled: false };
  abort.signal.addEventListener("abort", () => {
    if (current?.jobId === jobId) current.cancelled = true;
  });
  await persistQueue();
  try {
    progress(jobId, "acquiring-tab", "Looking for a flow.google.com tab");
    const tab = await findFlowTab();
    if (!tab) {
      failJob(jobId, "no flow.google.com tab is open. Open Google Flow and leave that tab visible.", true);
      return;
    }
    if (abort.signal.aborted) return;
    wsSend({ t: "job.accepted", jobId });
    await focusTab(tab);
    const probe = await ensureContent(tab.id);
    if (!probe?.ok) {
      failJob(
        jobId,
        "Flow Connector cannot run on this tab. Allow it on flow.google.com from the extensions menu, then reload the tab.",
        true
      );
      return;
    }
    let files = [];
    try {
      files = await Promise.all(fileList(item).map(fetchToken));
    } catch (err) {
      failJob(jobId, err instanceof Error ? err.message : String(err), true);
      return;
    }
    if (abort.signal.aborted) return;
    let attempt = 1;
    let outcome = await driveTab(tab.id, job, files, attempt, abort.signal);
    if (outcome?.type === "need-home" && job.params?.newProject && !abort.signal.aborted) {
      progress(jobId, "preparing-page", "Opening Flow home to start a new project");
      await chrome.tabs.update(tab.id, { url: "https://flow.google.com/" });
      await waitTabComplete(tab.id, 20000);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await ensureContent(tab.id);
      attempt = 2;
      outcome = await driveTab(tab.id, job, files, attempt, abort.signal);
    }
    if (abort.signal.aborted || outcome?.type === "cancelled") return;
    if (outcome?.type === "done") {
      finishJob(jobId, outcome.files || [], outcome.warning);
      return;
    }
    if (outcome?.type === "need-home") {
      failJob(jobId, "could not find a New project control on flow.google.com", false);
      return;
    }
    failJob(jobId, outcome?.reason || "the Flow tab closed before the job finished", !!outcome?.retryable);
  } catch (err) {
    if (abort.signal.aborted) return;
    failJob(jobId, err instanceof Error ? err.message : String(err), true);
  } finally {
    if (current?.jobId === jobId) current = null;
    void persistQueue();
    void sendStatus();
  }
}

function driveTab(tabId, job, files, attempt, signal) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.tabs.connect(tabId, { name: "flow-job" });
    } catch (err) {
      resolve({ type: "failed", reason: err instanceof Error ? err.message : String(err), retryable: true });
      return;
    }
    let settled = false;
    let started = false;
    const timer = setTimeout(() => {
      finish({
        type: "failed",
        reason: "timed out waiting for the Flow page to finish this job",
        retryable: true
      });
      try { port.disconnect(); } catch { /* already gone */ }
    }, watchdogMs(job));
    const readyTimer = setTimeout(() => {
      if (!started) {
        finish({
          type: "failed",
          reason: "the Flow page did not accept the job. Reload the flow.google.com tab and try again.",
          retryable: true
        });
      }
    }, 10000);

    function finish(outcome) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(readyTimer);
      try { port.disconnect(); } catch { /* already gone */ }
      resolve(outcome);
    }

    function sendPayload() {
      const jobId = job.id || current?.jobId;
      port.postMessage({ type: "start", job: { ...job, id: jobId }, fileCount: files.length, attempt });
      for (let index = 0; index < files.length; index++) {
        const encoded = bufferToBase64(files[index].bytes);
        const size = 256 * 1024;
        const chunks = Math.max(1, Math.ceil(encoded.length / size));
        for (let chunk = 0; chunk < chunks; chunk++) {
          port.postMessage({
            type: "file-chunk",
            index,
            chunk,
            chunks,
            name: files[index].name,
            mime: files[index].mime,
            data: encoded.slice(chunk * size, (chunk + 1) * size)
          });
        }
      }
      port.postMessage({ type: "files-done" });
    }

    if (current) current.port = port;
    port.onDisconnect.addListener(() => {
      if (signal.aborted) finish({ type: "cancelled" });
      else finish({ type: "failed", reason: "the Flow tab closed or reloaded during the job", retryable: true });
    });
    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ready" && !started) {
        started = true;
        clearTimeout(readyTimer);
        try {
          sendPayload();
        } catch (err) {
          finish({
            type: "failed",
            reason: `could not pass this job to the Flow tab (${err instanceof Error ? err.message : err})`,
            retryable: false
          });
        }
        return;
      }
      if (msg.type === "progress") progress(job.id || current?.jobId, msg.stage, msg.message, msg.pct);
      else if (msg.type === "arm") armDownload(msg, port);
      else if (msg.type === "disarm") disarm(msg.id);
      else if (msg.type === "download") void directDownload(msg, port);
      else if (msg.type === "done" || msg.type === "failed" || msg.type === "cancelled" || msg.type === "need-home") {
        finish(msg);
      }
    });
    signal.addEventListener("abort", () => {
      try { port.postMessage({ type: "cancel" }); } catch { /* port already closed */ }
      try { port.disconnect(); } catch { /* port already closed */ }
    });
  });
}

function armDownload(msg, port) {
  disarm(arm?.id);
  let settled = false;
  const pending = {
    id: msg.id,
    filename: msg.filename,
    downloadId: null,
    started: false,
    named: false
  };
  arm = pending;
  const startTimer = setTimeout(() => {
    if (!pending.started) settle({ ok: false, reason: "the page did not start a download" });
  }, 12000);
  const doneTimer = setTimeout(() => {
    settle({ ok: false, reason: "the download did not finish" });
  }, 120000);

  function settle(result) {
    if (settled) return;
    settled = true;
    clearTimeout(startTimer);
    clearTimeout(doneTimer);
    if (arm === pending) arm = null;
    try { port.postMessage({ type: "download-result", id: msg.id, ...result }); } catch { /* tab gone */ }
  }

  pending.settle = settle;
  try { port.postMessage({ type: "armed", id: msg.id }); } catch { /* tab gone */ }
}

function disarm(id) {
  if (arm && (!id || arm.id === id)) {
    const pending = arm;
    arm = null;
    pending.settle?.({ ok: false, reason: "download cancelled" });
  }
}

function looksMedia(item) {
  const blob = `${item.mime || ""} ${item.filename || ""} ${item.url || ""}`.toLowerCase();
  return /image|video|png|jpe?g|webp|gif|mp4|webm|mov|quicktime|octet-stream/.test(blob) || String(item.url || "").startsWith("blob:");
}

function downloadsRelative(absPath, requested) {
  if (!absPath) return requested;
  const normalized = absPath.replace(/\\/g, "/");
  const marker = "/downloads/";
  const at = normalized.toLowerCase().lastIndexOf(marker);
  if (at >= 0) return normalized.slice(at + marker.length);
  return requested;
}

if (chrome.downloads.onDeterminingFilename) chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  try {
    if (apiDepth > 0) {
      suggest();
      return;
    }
    if (arm && !arm.named && looksMedia(item)) {
      arm.named = true;
      arm.started = true;
      arm.downloadId = item.id;
      suggest({ filename: arm.filename, conflictAction: "uniquify" });
      return;
    }
  } catch (err) {
    log("error", "downloads", err instanceof Error ? err.message : String(err));
  }
  suggest();
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!arm || arm.downloadId == null || delta.id !== arm.downloadId) return;
  const pending = arm;
  if (delta.state?.current === "complete") {
    chrome.downloads.search({ id: delta.id }, (items) => {
      const path = downloadsRelative(items?.[0]?.filename, pending.filename);
      pending.settle?.({ ok: true, path });
    });
  } else if (delta.state?.current === "interrupted") {
    pending.settle?.({ ok: false, reason: delta.error?.current || "download interrupted" });
  }
});

function downloadUrl(url, filename) {
  return new Promise((resolve) => {
    apiDepth++;
    chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false }, (id) => {
      apiDepth = Math.max(0, apiDepth - 1);
      if (chrome.runtime.lastError || id == null) {
        resolve({ ok: false, reason: chrome.runtime.lastError?.message || "download failed" });
        return;
      }
      const timer = setTimeout(() => {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve({ ok: false, reason: "the download did not finish" });
      }, 120000);
      function onChanged(delta) {
        if (delta.id !== id) return;
        if (delta.state?.current === "complete") {
          clearTimeout(timer);
          chrome.downloads.onChanged.removeListener(onChanged);
          chrome.downloads.search({ id }, (items) => {
            resolve({ ok: true, path: downloadsRelative(items?.[0]?.filename, filename) });
          });
        } else if (delta.state?.current === "interrupted") {
          clearTimeout(timer);
          chrome.downloads.onChanged.removeListener(onChanged);
          resolve({ ok: false, reason: delta.error?.current || "download interrupted" });
        }
      }
      chrome.downloads.onChanged.addListener(onChanged);
    });
  });
}

async function directDownload(msg, port) {
  let url = msg.url;
  let created = null;
  try {
    if (msg.bytes) {
      const bytes = new Uint8Array(msg.bytes);
      created = URL.createObjectURL(new Blob([bytes], { type: msg.mime || "application/octet-stream" }));
      url = created;
    }
    const result = url
      ? await downloadUrl(url, msg.filename)
      : { ok: false, reason: "no download URL" };
    try { port.postMessage({ type: "download-result", id: msg.id, ...result }); } catch { /* tab gone */ }
  } finally {
    if (created) setTimeout(() => URL.revokeObjectURL(created), 60000);
  }
}

async function withFlowTab(work, empty) {
  const tab = await findFlowTab();
  if (!tab) {
    wsSend(empty);
    return;
  }
  const probe = await ensureContent(tab.id);
  if (!probe?.ok) {
    wsSend(empty);
    return;
  }
  try {
    await work(tab.id);
  } catch (err) {
    log("warn", "page", err instanceof Error ? err.message : String(err));
    wsSend(empty);
  }
}

async function replyHealthcheck() {
  const empty = { t: "healthcheck.result", entries: [], diagnostics: { buttons: [] } };
  await withFlowTab(async (tabId) => {
    const result = await chrome.tabs.sendMessage(tabId, { type: "healthcheck" });
    wsSend({
      t: "healthcheck.result",
      entries: result?.entries || [],
      diagnostics: result?.diagnostics || {}
    });
  }, empty);
}

async function replyDom(msg) {
  const empty = { t: "dom.result", url: "", roots: 0, items: [] };
  await withFlowTab(async (tabId) => {
    const result = await chrome.tabs.sendMessage(tabId, {
      type: "dom",
      selector: msg.selector,
      clickFirst: msg.clickFirst
    });
    wsSend({
      t: "dom.result",
      url: result?.url,
      roots: result?.roots,
      items: result?.items || []
    });
  }, empty);
}

async function replyLogs() {
  let pageEntries = [];
  const tab = await findFlowTab();
  if (tab) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: "logs" });
      pageEntries = result?.entries || [];
    } catch { /* tab has no content script */ }
  }
  wsSend({ t: "logs.result", entries: [...logs, ...pageEntries].slice(-200) });
}

function endOfJsonObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === "\"") inString = false;
      continue;
    }
    if (c === "\"") inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function extractJsonObject(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  let i = at + marker.length;
  while (html[i] === " " || html[i] === "\n") i++;
  if (html[i] !== "{") return null;
  const end = endOfJsonObject(html, i);
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(i, end));
  } catch {
    return null;
  }
}

function hasNestedKey(node, name) {
  const stack = [node];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (Object.prototype.hasOwnProperty.call(cur, name)) return true;
    if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i++) stack.push(cur[i]);
      continue;
    }
    const keys = Object.keys(cur);
    for (let i = 0; i < keys.length; i++) stack.push(cur[keys[i]]);
  }
  return false;
}

function channelMention(node) {
  let ours = false;
  let other = false;
  const stack = [node];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i++) stack.push(cur[i]);
      continue;
    }
    if (typeof cur.channelId === "string") {
      if (cur.channelId === CHANNEL_ID) ours = true;
      else other = true;
    }
    if (Array.isArray(cur.channelIds)) {
      for (const id of cur.channelIds) {
        if (id === CHANNEL_ID) ours = true;
        else if (typeof id === "string" && id.startsWith("UC")) other = true;
      }
    }
    const keys = Object.keys(cur);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] === "channelId" || keys[i] === "channelIds") continue;
      const child = cur[keys[i]];
      if (child && typeof child === "object") stack.push(child);
    }
  }
  if (ours) return "ours";
  if (other) return "other";
  return "none";
}

function subscriptionState(node, key) {
  if (typeof node.subscribed === "boolean") return node.subscribed;
  if (!/subscribe/i.test(key) || typeof node.state !== "string") return null;
  const state = node.state.toUpperCase();
  if (state.includes("UNSUBSCRIB") || state.includes("NOT_SUBSCRIB")) return false;
  if (state.includes("SUBSCRIB")) return true;
  return null;
}

function findSubscribedFlag(root) {
  let sawTrue = false;
  let sawFalse = false;
  const stack = [{ node: root, key: "", inHeader: false }];
  while (stack.length) {
    const { node, key, inHeader } = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) stack.push({ node: node[i], key, inHeader });
      continue;
    }
    const nextHeader = inHeader || key === "header" || key === "pageHeaderRenderer" || key === "pageHeaderViewModel";
    const flag = subscriptionState(node, key);
    if (flag !== null) {
      const who = channelMention(node);
      const signInOnly = flag === false
        && hasNestedKey(node, "signInEndpoint")
        && !hasNestedKey(node, "subscribeEndpoint")
        && !hasNestedKey(node, "unsubscribeEndpoint");
      if (!signInOnly && who !== "other" && (who === "ours" || inHeader)) {
        if (flag) sawTrue = true;
        else sawFalse = true;
      }
    }
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const child = node[keys[i]];
      if (child && typeof child === "object") stack.push({ node: child, key: keys[i], inHeader: nextHeader });
    }
  }
  if (sawTrue) return true;
  if (sawFalse) return false;
  return null;
}

function loggedInState(data, html) {
  let inn = false;
  let out = false;
  if (html) {
    if (/"LOGGED_IN"\s*:\s*true/.test(html)) inn = true;
    if (/"LOGGED_IN"\s*:\s*false/.test(html)) out = true;
  }
  const loggedOut = data?.responseContext?.mainAppWebResponseContext?.loggedOut;
  if (loggedOut === true) out = true;
  if (loggedOut === false) inn = true;
  const groups = data?.responseContext?.serviceTrackingParams;
  if (Array.isArray(groups)) {
    for (const group of groups) {
      const params = group?.params;
      if (!Array.isArray(params)) continue;
      for (const param of params) {
        if (!param || (param.key !== "logged_in" && param.key !== "yt_li")) continue;
        if (param.value === "1") inn = true;
        if (param.value === "0") out = true;
      }
    }
  }
  if (inn && out) return "conflict";
  if (inn) return "in";
  if (out) return "out";
  return "unknown";
}

function classifySubscription(data, html) {
  const login = loggedInState(data, html);
  if (login === "out" || login === "conflict") return "unknown";
  const flag = data ? findSubscribedFlag(data) : null;
  if (flag === true) return "subscribed";
  if (flag === false && login === "in") return "unsubscribed";
  return "unknown";
}

async function browseChannel(html) {
  const version = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
  if (!version) return null;
  const clientVersion = version[1];
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  const query = key ? `?prettyPrint=false&key=${encodeURIComponent(key[1])}` : "?prettyPrint=false";
  const res = await fetch(`https://www.youtube.com/youtubei/v1/browse${query}`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      "x-youtube-client-name": "1",
      "x-youtube-client-version": clientVersion
    },
    body: JSON.stringify({
      context: { client: { clientName: "WEB", clientVersion } },
      browseId: CHANNEL_ID
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data && typeof data === "object" ? data : null;
}

async function detectChannelSubscription() {
  // Subscription check for channel UCf81rjZnBT9mo_PCXds62BQ.
  let html = "";
  try {
    const res = await fetch(CHANNEL_URL, {
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      log("info", "gate", `channel page HTTP ${res.status}; opening bridge socket`);
      return "unknown";
    }
    const finalUrl = res.url || "";
    if (/consent\.youtube\.com|consent\.google\.com|accounts\.google\.com/i.test(finalUrl)) {
      log("info", "gate", "consent or sign-in page; opening bridge socket");
      return "unknown";
    }
    html = await res.text();
    if (/before you continue to youtube/i.test(html) && !html.includes("ytInitialData")) {
      log("info", "gate", "consent wall; opening bridge socket");
      return "unknown";
    }
    const page = extractJsonObject(html, "var ytInitialData = ");
    const state = classifySubscription(page, html);
    if (state !== "unknown") return state;
  } catch (err) {
    log("info", "gate", `channel page failed (${err instanceof Error ? err.message : err}); opening bridge socket`);
    return "unknown";
  }
  log("info", "gate", "channel page had no subscription flag; trying browse");
  try {
    const browsed = await browseChannel(html);
    if (!browsed) return "unknown";
    return classifySubscription(browsed, "");
  } catch (err) {
    log("info", "gate", `browse failed (${err instanceof Error ? err.message : err}); opening bridge socket`);
    return "unknown";
  }
}

async function readSessionGate() {
  try {
    const stored = await chrome.storage.session.get(SESSION_GATE_KEY);
    const value = stored?.[SESSION_GATE_KEY];
    if (value === "subscribed" || value === "unsubscribed") return value;
  } catch (err) {
    log("warn", "gate", err instanceof Error ? err.message : String(err));
  }
  return null;
}

async function runSubscriptionCheck(force) {
  if (force) {
    try { await chrome.storage.session.remove(SESSION_GATE_KEY); } catch { /* session storage unavailable */ }
  } else {
    const cached = await readSessionGate();
    if (cached) {
      log("info", "gate", cached === "unsubscribed"
        ? "session cache not subscribed; bridge socket stays closed"
        : "session cache subscribed; opening bridge socket");
      return cached;
    }
  }
  const state = await detectChannelSubscription();
  if (state === "subscribed" || state === "unsubscribed") {
    try { await chrome.storage.session.set({ [SESSION_GATE_KEY]: state }); } catch { /* session storage unavailable */ }
  } else {
    try { await chrome.storage.session.remove(SESSION_GATE_KEY); } catch { /* session storage unavailable */ }
  }
  log("info", "gate", state === "unsubscribed"
    ? "not subscribed; bridge socket stays closed"
    : state === "subscribed"
      ? "subscribed; opening bridge socket"
      : "subscription unknown; opening bridge socket");
  return state;
}

function blockBridge() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  helloReady = false;
  const ws = socket;
  socket = null;
  if (ws) {
    try { ws.close(); } catch { /* already closed */ }
  }
}

function ensureSubscription(force) {
  const epoch = ++gateEpoch;
  subGate = null;
  const promise = runSubscriptionCheck(!!force).then((state) => {
    if (epoch !== gateEpoch) return gatePromise;
    subGate = state;
    if (state === "unsubscribed") blockBridge();
    else connect();
    return state;
  }, () => {
    if (epoch !== gateEpoch) return gatePromise;
    subGate = "unknown";
    log("info", "gate", "subscription check failed; opening bridge socket");
    connect();
    return "unknown";
  });
  gatePromise = promise;
  return promise;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "popup-status") {
    const pending = gatePromise || Promise.resolve(subGate || "unknown");
    pending.then(() => collectPageState()).then((snap) => {
      sendResponse({
        connected: subGate !== "unsubscribed" && !!(socket && socket.readyState === WebSocket.OPEN && helloReady),
        lastError,
        activeJobs: current ? 1 : 0,
        queued: queue.length,
        subscription: subGate || "unknown",
        channelUrl: CHANNEL_URL,
        ...snap
      });
    }).catch(() => sendResponse({
      connected: false,
      lastError,
      activeJobs: 0,
      subscription: subGate || "unknown",
      channelUrl: CHANNEL_URL
    }));
    return true;
  }
  if (msg?.type === "content-log") {
    log(msg.level || "info", "page", msg.message || "");
  }
  return false;
});

chrome.tabs.onActivated.addListener(() => scheduleStatusPush());
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === "complete" || info.url) scheduleStatusPush();
});
chrome.windows.onFocusChanged.addListener(() => scheduleStatusPush());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "flow-bridge") return;
  if (subGate === "unsubscribed") return;
  if (!socket || socket.readyState !== WebSocket.OPEN) connect();
  else wsSend({ t: "ext.heartbeat" });
});

function boot(reason) {
  if (!booted) {
    booted = true;
    chrome.alarms.create("flow-bridge", { periodInMinutes: 0.5 });
    void restoreQueue();
  }
  void ensureSubscription(reason === "installed" || reason === "startup");
  if (connectTimer) clearInterval(connectTimer);
  connectTimer = setInterval(() => {
    if (subGate === "unsubscribed") return;
    if (!socket || socket.readyState !== WebSocket.OPEN) connect();
    else wsSend({ t: "ext.heartbeat" });
  }, 20000);
}

chrome.runtime.onInstalled.addListener(() => boot("installed"));
chrome.runtime.onStartup.addListener(() => boot("startup"));
boot("worker");
