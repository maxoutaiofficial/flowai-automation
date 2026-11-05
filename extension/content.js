// Licensed under the MIT License by MaxOut AI. You may use, modify, and redistribute this code if you keep this copyright notice and the MIT license terms.
/**
 * Runs a bridge job on the open flow.google.com tab.
 * Selectors follow the labels Google documents (Generate, Image, Video,
 * Video Frames, Video Ingredients, Characters, Extend, Download). When a
 * control is not on the page, the job fails with that reason.
 */
(() => {
if (globalThis.__flowConnectorContent) return;
globalThis.__flowConnectorContent = true;

let live = null;

function install() {
  const pageLogs = [];

  function pageLog(level, message) {
    pageLogs.push({ ts: Date.now(), level, scope: "page", message: String(message) });
    if (pageLogs.length > 100) pageLogs.shift();
    try {
      chrome.runtime.sendMessage({ type: "content-log", level, message: String(message) });
    } catch { /* worker asleep */ }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type === "ping") {
      sendResponse(probe());
      return false;
    }
    if (msg.type === "healthcheck") {
      sendResponse(healthcheck());
      return false;
    }
    if (msg.type === "logs") {
      sendResponse({ entries: pageLogs });
      return false;
    }
    if (msg.type === "dom") {
      const click = msg.clickFirst ? findClickable(document, [new RegExp(escapeReg(msg.clickFirst), "i")]) : null;
      if (click) clickEl(click);
      setTimeout(() => sendResponse(dumpDom(msg.selector)), click ? 400 : 0);
      return true;
    }
    return false;
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "flow-job") return;
    if (live?.abort) live.abort.abort();
    const session = { port, abort: null, build: null };
    live = session;
    port.onDisconnect.addListener(() => {
      session.abort?.abort();
      if (live === session) live = null;
    });
    port.onMessage.addListener((msg) => onPort(session, msg));
    try { port.postMessage({ type: "ready" }); } catch { /* disconnected */ }
  });

  function onPort(session, msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "cancel") {
      session.abort?.abort();
      return;
    }
    if (msg.type === "start") {
      session.build = { job: msg.job, attempt: msg.attempt || 1, fileCount: msg.fileCount || 0, parts: new Map() };
      return;
    }
    if (msg.type === "file-chunk" && session.build) {
      const current = session.build.parts.get(msg.index) || { parts: [], name: msg.name, mime: msg.mime, chunks: msg.chunks };
      current.parts[msg.chunk] = msg.data;
      session.build.parts.set(msg.index, current);
      return;
    }
    if (msg.type === "files-done" && session.build) {
      const built = session.build;
      session.build = null;
      const abort = new AbortController();
      session.abort = abort;
      void runBuilt(session.port, built, abort.signal);
    }
  }

  async function runBuilt(port, built, signal) {
    try {
      const files = [];
      for (let index = 0; index < built.fileCount; index++) {
        const rec = built.parts.get(index);
        if (!rec || rec.parts.filter(Boolean).length !== rec.chunks) {
          throw new StepError(`input file ${index + 1} did not arrive complete`);
        }
        files.push({ name: rec.name, mime: rec.mime, bytes: base64ToBytes(rec.parts.join("")) });
      }
      const outcome = await runJob(built.job, files, built.attempt, signal, (stage, message, pct) => {
        try { port.postMessage({ type: "progress", stage, message, pct }); } catch { /* port closed */ }
      });
      if (signal.aborted) {
        try { port.postMessage({ type: "cancelled" }); } catch { /* port closed */ }
        return;
      }
      if (outcome?.needHome) {
        try { port.postMessage({ type: "need-home" }); } catch { /* port closed */ }
        return;
      }
      try { port.postMessage({ type: "done", files: outcome.files || [], warning: outcome.warning }); } catch { /* port closed */ }
    } catch (err) {
      if (signal.aborted || err?.name === "AbortError") {
        try { port.postMessage({ type: "cancelled" }); } catch { /* port closed */ }
        return;
      }
      pageLog("error", err?.message || err);
      try {
        port.postMessage({
          type: "failed",
          reason: err?.message || String(err),
          retryable: !!err?.retryable
        });
      } catch { /* port closed */ }
    }
  }
}

class StepError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

function escapeReg(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function norm(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
}

async function waitFor(fn, ms, what, signal) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    throwIfAborted(signal);
    const value = fn();
    if (value) return value;
    await sleep(250, signal);
  }
  throw new StepError(`could not find ${what}`);
}

function queryAllDeep(selector, root = document, depth = 0) {
  if (!root?.querySelectorAll || depth > 4) return [];
  const found = [...root.querySelectorAll(selector)];
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) found.push(...queryAllDeep(selector, el.shadowRoot, depth + 1));
  }
  return found;
}

function visible(el) {
  if (!el || !el.isConnected) return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function labelOf(el) {
  if (!el?.getAttribute) return "";
  const aria = el.getAttribute("aria-label") || el.getAttribute("title") || "";
  if (norm(aria)) return norm(aria);
  const labelled = el.getAttribute("aria-labelledby");
  if (labelled) {
    const text = labelled.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
    if (norm(text)) return norm(text);
  }
  const text = textWithoutIcons(el);
  return text.length > 80 ? "" : text;
}

// Flow's buttons now carry Material icon ligatures ("image Images"). Drop the
// icon glyph text so labels read "Images", not "image Images".
const ICON_SELECTOR = [
  "mat-icon",
  "i",
  '[class*="material-icons"]',
  '[class*="material-symbols"]',
  '[class*="google-symbols"]',
  '[class*="icon"][aria-hidden="true"]',
  '[data-icon]'
].join(", ");

function textWithoutIcons(el) {
  let text = "";
  if (el.querySelector?.(ICON_SELECTOR)) {
    const copy = el.cloneNode(true);
    copy.querySelectorAll(ICON_SELECTOR).forEach((node) => node.remove());
    text = norm(copy.textContent || "");
  }
  if (!text) text = norm(el.innerText || el.textContent || "");
  // Fallback when the icon is not marked up: a lower-case ligature word in
  // front of a capitalised label ("image Images", "videocam Video").
  const lead = text.match(/^[a-z][a-z0-9_]*\s+(?=[A-Z0-9])/);
  if (lead && text.length > lead[0].length) text = text.slice(lead[0].length);
  return text;
}

function findClickable(root, patterns) {
  const scope = root?.querySelectorAll ? root : document;
  const els = queryAllDeep('button, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"], [role="link"], a, label', scope);
  if (scope.nodeType === 1) els.unshift(scope);
  let best = null;
  let bestScore = Infinity;
  for (const el of els) {
    if (!visible(el)) continue;
    const text = labelOf(el);
    if (!text || /^download project$/i.test(text)) continue;
    for (let i = 0; i < patterns.length; i++) {
      if (!patterns[i].test(text)) continue;
      const score = i * 10000 + text.length;
      if (score < bestScore) {
        best = el;
        bestScore = score;
      }
      break;
    }
  }
  return best;
}

function clickEl(el) {
  el.scrollIntoView({ block: "center", inline: "nearest" });
  const opts = { bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.click();
}

function findPrompt() {
  const boxes = queryAllDeep('textarea, [contenteditable="true"], [role="textbox"]');
  let best = null;
  let score = -1;
  for (const el of boxes) {
    if (!visible(el)) continue;
    const hint = norm(`${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""} ${el.getAttribute("data-placeholder") || ""}`);
    const rect = el.getBoundingClientRect();
    let next = rect.width * Math.min(rect.height, 220);
    if (/what do you want|prompt|describe|create|edit this video|character/i.test(hint)) next += 1e7;
    if (next > score) {
      best = el;
      score = next;
    }
  }
  return best;
}

function composerRoot() {
  const prompt = findPrompt();
  if (!prompt) return document.body || document.documentElement;
  let el = prompt;
  for (let i = 0; i < 6 && el.parentElement; i++) {
    el = el.parentElement;
    const rect = el.getBoundingClientRect();
    if (rect.height > 360 && rect.width > 260) return el;
  }
  return el;
}

function layoutOf() {
  const characters = findClickable(document, [/^characters$/i]);
  if (characters && window.innerWidth >= 900) return "wide";
  return window.innerWidth >= 1180 ? "wide" : "narrow";
}

function loggedIn() {
  if (findPrompt() || findClickable(document, [/^new project$/i, /^characters$/i])) return true;
  if (/\/project\//.test(location.pathname)) return true;
  return !findClickable(document, [/^sign in$/i]);
}

function probe() {
  return {
    ok: true,
    loggedIn: loggedIn(),
    visible: document.visibilityState === "visible",
    flowLayout: layoutOf(),
    url: location.href
  };
}

function buttonSample() {
  return queryAllDeep('button, [role="button"]')
    .filter(visible)
    .map(labelOf)
    .filter((text) => text && text.length < 40)
    .slice(0, 20);
}

function healthcheck() {
  const prompt = findPrompt();
  const generate = findClickable(document, [/^generate$/i, /^create$/i, /send prompt/i]);
  const chip = findClickable(composerRoot(), [/nano banana/i, /veo\s*3/i, /omni/i, /^images?$/i, /^videos?$/i, /settings/i]);
  const file = queryAllDeep('input[type="file"]')[0] || findClickable(document, [/^add$/i, /^upload$/i]);
  const entry = (key, el, strategy) => ({
    key,
    matched: !!el,
    strategy,
    snippet: el ? labelOf(el).slice(0, 80) : ""
  });
  return {
    entries: [
      entry("prompt", prompt, "textarea, contenteditable, or role=textbox"),
      entry("generate", generate, "button labelled Generate, Create, or Send"),
      entry("mode-chip", chip, "model, Image, Video, or settings control in the composer"),
      entry("file-input", file, "input[type=file] or an Add/Upload button")
    ],
    diagnostics: { url: location.href, layout: layoutOf(), buttons: buttonSample() }
  };
}

function dumpDom(selector) {
  const root = selector ? queryAllDeep(selector) : queryAllDeep('button, [role="button"], textarea, [contenteditable="true"], [role="textbox"], input, a');
  const items = root.slice(0, 80).map((el) => ({
    tag: el.tagName?.toLowerCase() || "",
    role: el.getAttribute?.("role") || "",
    label: labelOf(el).slice(0, 80),
    text: norm(el.innerText || el.getAttribute?.("placeholder") || "").slice(0, 80)
  }));
  return { url: location.href, roots: root.length, items };
}

function dismissNoise() {
  const el = findClickable(document, [/^got it$/i, /^not now$/i, /^dismiss$/i, /^no thanks$/i]);
  if (el) clickEl(el);
}

function modeHint() {
  const text = norm(composerRoot().innerText || "").slice(0, 2000).toLowerCase();
  if (/video frames|frames to video|add start frame|add end frame/.test(text)) return "frames";
  if (/ingredient/.test(text)) return "ingredients";
  if (/nano banana/.test(text) && !/veo|omni/.test(text)) return "image";
  if (/\bvideos?\b/.test(text) && /veo|omni/.test(text)) return "video";
  return "";
}

async function openMenu(signal) {
  const chip = findClickable(composerRoot(), [
    /nano banana/i,
    /veo\s*3/i,
    /omni/i,
    /^images?$/i,
    /^videos?$/i,
    /settings/i,
    /^tune$/i,
    /^model$/i
  ]);
  if (!chip) return false;
  clickEl(chip);
  await sleep(280, signal);
  return true;
}

function findMenuItem(patterns) {
  const layers = queryAllDeep('[role="menu"], [role="listbox"], [role="dialog"], [role="radiogroup"], dialog, [popover]').filter(visible);
  for (const layer of layers) {
    const hit = findClickable(layer, patterns);
    if (hit) return hit;
  }
  const root = composerRoot();
  const box = root.getBoundingClientRect();
  const hits = [];
  for (const el of queryAllDeep('button, [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="radio"]')) {
    if (!visible(el)) continue;
    const text = labelOf(el);
    if (!text || !patterns.some((pattern) => pattern.test(text))) continue;
    const rect = el.getBoundingClientRect();
    const near = root.contains(el) || Math.abs(rect.top - box.bottom) < 520 || Math.abs(rect.left - box.left) < 640;
    if (near) hits.push(el);
  }
  hits.sort((a, b) => labelOf(a).length - labelOf(b).length);
  return hits[0] || null;
}

async function choose(patterns, signal) {
  let el = findMenuItem(patterns);
  if (!el) {
    const opened = await openMenu(signal);
    if (opened) el = findMenuItem(patterns);
  }
  if (!el) return false;
  clickEl(el);
  await sleep(220, signal);
  return true;
}

const MODE_CHOICE = {
  "flow-text-to-image": { hint: "image", choices: [/^images?$/i] },
  "flow-image-to-image": { hint: "image", choices: [/^images?$/i] },
  "flow-text-to-video": { hint: "video", choices: [/^videos?$/i, /^text to video$/i] },
  "flow-frame-to-video": { hint: "frames", choices: [/video frames/i, /^(video )?frames$/i, /frames to video/i] },
  "flow-ingredients-to-video": { hint: "ingredients", choices: [/video ingredients/i, /^(video )?ingredients$/i] },
  "flow-video-to-video": { hint: "ingredients", choices: [/video ingredients/i, /^(video )?ingredients$/i, /edit video/i] }
};

const MODEL_CHOICE = {
  "nano-banana-pro": [/nano banana pro/i],
  "nano-banana-2": [/nano banana 2\.1/i, /nano banana 2(?!\s*lite)/i],
  "nano-banana-2-lite": [/nano banana 2 lite/i],
  "omni-flash": [/omni flash/i, /omni 1\.1 flash/i],
  "veo-3.1-lite": [/veo 3\.1 lite/i, /veo 3\.1\s*-\s*lite/i],
  "veo-3.1-fast": [/veo 3\.1 fast/i, /veo 3\.1\s*-\s*fast/i],
  "veo-3.1-quality": [/veo 3\.1 quality/i, /veo 3\.1\s*-\s*quality/i]
};

async function applyMode(mode, signal) {
  const spec = MODE_CHOICE[mode];
  if (!spec) return;
  if (modeHint() === spec.hint) return;
  const picked = await choose(spec.choices, signal);
  if (!picked && modeHint() !== spec.hint) {
    const sample = buttonSample().join(", ") || "none";
    throw new StepError(`could not find the ${spec.choices[0]} control for ${mode}. Visible buttons: ${sample}`);
  }
}

async function applySettings(job, signal) {
  const notes = [];
  const params = job.params || {};
  const model = MODEL_CHOICE[params.imageModel];
  if (params.imageModel && !model) {
    notes.push(`this page has no chip for model "${params.imageModel}"`);
  } else if (model && !(await choose(model, signal))) {
    notes.push(`could not find the model control for ${params.imageModel}; Flow kept the model already selected`);
  }
  if (params.aspectRatio && !(await choose([new RegExp(`^${escapeReg(params.aspectRatio)}$`, "i")], signal))) {
    notes.push(`could not find the ${params.aspectRatio} aspect control; Flow kept the shape already selected`);
  }
  const outputs = params.outputsPerPrompt || 1;
  const outputPatterns = [
    new RegExp(`^x\\s*${outputs}$`, "i"),
    new RegExp(`^${outputs}\\s*x$`, "i"),
    new RegExp(`^${outputs}$`),
    new RegExp(`${outputs}\\s*outputs?`, "i")
  ];
  if (!(await choose(outputPatterns, signal))) {
    notes.push(`could not find an output-count control for ${outputs}`);
  }
  if (params.videoOption) {
    const seconds = String(params.videoOption).replace(/-concat$/, "");
    const picked = await choose([new RegExp(`^${escapeReg(seconds)}$`, "i"), new RegExp(`^${escapeReg(seconds.replace(/s$/, ""))}\\s*s$`, "i")], signal);
    if (!picked) notes.push(`could not find a ${seconds} duration control; Flow kept the length already selected`);
  }
  if (params.videoResolution === "480p") {
    if (!(await choose([/^360p$/i, /^480p$/i], signal))) notes.push("could not find Flow's 360p control (the 480p value maps to it)");
  } else if (params.videoResolution === "720p") {
    if (!(await choose([/^720p$/i], signal))) notes.push("could not find the 720p control");
  }
  return notes;
}

function fileInputs() {
  return queryAllDeep('input[type="file"]');
}

async function revealFileInput(signal) {
  const ready = fileInputs().find((input) => !input.disabled);
  if (ready) return ready;
  const opener = findClickable(document, [/^add$/i, /^\+$/, /^upload$/i, /upload media/i, /add media/i, /from computer/i, /upload file/i]);
  if (opener) clickEl(opener);
  await sleep(300, signal);
  return fileInputs().find((input) => !input.disabled) || null;
}

function toFile(payload) {
  const bytes = payload.bytes instanceof Uint8Array ? payload.bytes : new Uint8Array(payload.bytes);
  return new File([bytes], payload.name || "upload.bin", { type: payload.mime || "application/octet-stream" });
}

function setInputFiles(input, files) {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function findLabelElement(name) {
  const needle = name.trim().toLowerCase();
  const prompt = findPrompt();
  let best = null;
  let bestLen = Infinity;
  for (const el of queryAllDeep("button, a, [role='row'], [role='listitem'], [role='gridcell'], [role='option'], li, span, div, p")) {
    if (!visible(el)) continue;
    if (prompt && (el === prompt || prompt.contains(el) || el.contains(prompt))) continue;
    const text = norm(el.innerText || "");
    if (!text || text.length > 160 || text.length >= bestLen) continue;
    if (!text.toLowerCase().includes(needle)) continue;
    best = el;
    bestLen = text.length;
  }
  return best;
}

async function pickAsset(name, signal) {
  const search = queryAllDeep("input").find((el) => {
    if (!visible(el)) return false;
    const hint = `${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""}`;
    return /search|asset|media|character/i.test(hint);
  });
  if (search) {
    await setEditorText(search, name);
    await sleep(400, signal);
  }
  const row = findLabelElement(name);
  if (!row) return false;
  clickEl(row);
  await sleep(200, signal);
  return true;
}

async function attachFrames(job, files, signal) {
  const slots = [
    { patterns: [/add start frame/i, /start frame/i, /first frame/i], file: files[0], asset: job.assetRefs?.[0] },
    { patterns: [/add end frame/i, /end frame/i, /last frame/i], file: files[1], asset: job.assetRefs?.[1] }
  ];
  let attached = 0;
  for (const slot of slots) {
    if (!slot.file && !slot.asset) continue;
    const button = findClickable(document, slot.patterns);
    if (!button) throw new StepError(`could not find the ${slot.file === files[0] || slot.asset === job.assetRefs?.[0] ? "start" : "end"} frame control`);
    clickEl(button);
    await sleep(250, signal);
    if (slot.file) {
      const input = await revealFileInput(signal);
      if (!input) throw new StepError("could not find a file input for the frame slot");
      setInputFiles(input, [toFile(slot.file)]);
    } else if (!(await pickAsset(slot.asset, signal))) {
      throw new StepError(`could not find a project asset matching "${slot.asset}" for the frame slot`);
    }
    attached++;
  }
  if (!attached) throw new StepError("flow-frame-to-video needs a start frame (a file or an asset already in the project)");
}

async function attachGeneric(files, assetRefs, signal) {
  if (files.length) {
    const input = await revealFileInput(signal);
    if (!input) throw new StepError("could not find a file input. Looked for Add, +, Upload, and input[type=file].");
    setInputFiles(input, files.map(toFile));
    await sleep(400, signal);
  }
  for (const name of assetRefs || []) {
    const add = findClickable(composerRoot(), [/^add$/i, /^\+$/, /add media/i]);
    if (add) {
      clickEl(add);
      await sleep(250, signal);
    }
    if (!(await pickAsset(name, signal))) throw new StepError(`could not find a project asset matching "${name}"`);
  }
}

async function setEditorText(el, text) {
  el.focus();
  clickEl(el);
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (norm(el.value).includes(norm(text).slice(0, 24))) return;
  }
  document.execCommand("selectAll", false, null);
  document.execCommand("delete", false, null);
  document.execCommand("insertText", false, text);
  el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
  const got = norm(el.innerText || el.value || el.textContent || "");
  if (got.includes(norm(text).slice(0, Math.min(24, norm(text).length)))) return;
  if (el.getAttribute("contenteditable") === "true") el.textContent = text;
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  const after = norm(el.innerText || el.value || el.textContent || "");
  if (!after.includes(norm(text).slice(0, Math.min(24, norm(text).length)))) {
    throw new StepError("found a text field but it did not accept the text");
  }
}

function composedPrompt(job) {
  let text = job.prompt || "";
  for (const name of job.characterRefs || []) {
    if (!text.toLowerCase().includes(`@${name}`.toLowerCase())) text += ` @${name}`;
  }
  return text.trim();
}

async function submit(signal) {
  const button = findClickable(composerRoot(), [/^generate$/i, /^create$/i, /send prompt/i]) || findClickable(document, [/^generate$/i, /send prompt/i]);
  if (!button) throw new StepError("could not find a Generate control");
  const wasBusy = isGenerating();
  clickEl(button);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const approve = findClickable(document, [/^approve$/i]);
    if (approve) {
      clickEl(approve);
      return;
    }
    if (!wasBusy && isGenerating()) return;
    const err = pageError();
    if (err) throw new StepError(err.reason, err.retryable);
    await sleep(250, signal);
  }
}

function pageError() {
  const text = norm(document.body?.innerText || "").slice(0, 12000);
  const rules = [
    [/you(?:'|’)re out of google flow credits/i, "You're out of Google Flow credits. Wait until they refresh. This extension does not add credits.", false],
    [/violate(?:s|d)? our polic(?:y|ies)|content policy|try a different prompt/i, null, false],
    [/something went wrong/i, "Something went wrong on Flow. Nothing was saved.", true],
    [/unusual traffic|automated queries/i, "Flow asked for a check before it would continue. Wait, then try again.", true]
  ];
  for (const [pattern, reason, retryable] of rules) {
    const match = pattern.exec(text);
    if (!match) continue;
    const snippet = norm(text.slice(Math.max(0, match.index - 30), match.index + 140));
    return { reason: reason || snippet, retryable };
  }
  return null;
}

function isGenerating() {
  if (queryAllDeep('[role="progressbar"], [aria-busy="true"]').some(visible)) return true;
  const live = queryAllDeep('[aria-live], [role="status"]').map(labelOf).join(" ");
  return /generat|rendering|working on/i.test(live) && !/will use/i.test(live);
}

function largeMedia() {
  return queryAllDeep("img, video").filter((el) => {
    const rect = el.getBoundingClientRect();
    return visible(el) && rect.width >= 80 && rect.height >= 80;
  });
}

function mediaKey(el) {
  return el.currentSrc || el.src || el.poster || "";
}

function snapshot() {
  const media = largeMedia();
  return { keys: new Set(media.map(mediaKey).filter(Boolean)), count: media.length };
}

async function maybeDowngrade(job, signal) {
  if (job.params?.autoSwitchOnQuota === false) return false;
  const text = norm(document.body?.innerText || "");
  if (!/720/.test(text) || !/quota|unavailable|not enough|limit/i.test(text)) return false;
  if (!(await choose([/^360p$/i, /^480p$/i], signal))) return false;
  await submit(signal);
  return true;
}

async function waitForResults(before, kind, job, signal, timeout) {
  const start = Date.now();
  let sawBusy = false;
  let downgraded = false;
  while (Date.now() - start < timeout) {
    throwIfAborted(signal);
    const err = pageError();
    if (err) {
      if (!downgraded) {
        downgraded = true;
        if (await maybeDowngrade(job, signal)) continue;
      }
      throw new StepError(err.reason, err.retryable);
    }
    if (isGenerating()) sawBusy = true;
    const now = largeMedia();
    const fresh = now.filter((el) => {
      const key = mediaKey(el);
      return key && !before.keys.has(key);
    });
    const busy = isGenerating();
    if (fresh.length && !busy && Date.now() - start > 1500) return fresh;
    if (sawBusy && !busy && now.length > before.count && Date.now() - start > 1500) {
      return now.slice(now.length - (now.length - before.count));
    }
    await sleep(800, signal);
  }
  throw new StepError(`timed out waiting for a ${kind} to appear on the page`, true);
}

function nearbyLabel(el) {
  const alt = norm(el.getAttribute?.("alt") || "");
  if (alt.length > 2 && alt.length < 80) return alt;
  let parent = el;
  for (let i = 0; i < 5 && parent; i++) {
    const heading = [...parent.querySelectorAll("h1, h2, h3, h4")].map((node) => norm(node.innerText)).find((text) => text && text.length < 80);
    if (heading) return heading;
    parent = parent.parentElement;
  }
  return "";
}

function resultName(job, index, label, ext) {
  const folder = String(job.params?.downloadSubfolder || "flow-auto").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\.\./g, "") || "flow-auto";
  const number = job.batchIndex || index;
  const safe = norm(label).replace(/[\\/:*?"<>|]/g, " ").slice(0, 70) || "output";
  const suffix = job.batchIndex && index > 1 ? ` (${index})` : "";
  return `${folder}/${number} - ${safe}${suffix}.${ext}`;
}

function kindOf(mode) {
  return mode === "flow-text-to-image" || mode === "flow-image-to-image" ? "image" : "video";
}

function askDownload(port, message, signal) {
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: "download timed out" });
    }, 130000);
    function cleanup() {
      clearTimeout(timer);
      port.onMessage.removeListener(onMessage);
    }
    function onMessage(msg) {
      if (msg?.id !== id) return;
      if (msg.type === "armed" && message.type === "arm") {
        Promise.resolve()
          .then(() => message.afterArmed?.())
          .catch((err) => {
            try { port.postMessage({ type: "disarm", id }); } catch { /* port closed */ }
            cleanup();
            resolve({ ok: false, reason: err?.message || String(err) });
          });
        return;
      }
      if (msg.type === "download-result") {
        cleanup();
        resolve(msg);
      }
    }
    port.onMessage.addListener(onMessage);
    signal?.addEventListener("abort", () => {
      try { port.postMessage({ type: "disarm", id }); } catch { /* port closed */ }
      cleanup();
      resolve({ ok: false, reason: "cancelled" });
    }, { once: true });
    try {
      const payload = { type: message.type, id };
      if (message.filename) payload.filename = message.filename;
      if (message.url) payload.url = message.url;
      if (message.mime) payload.mime = message.mime;
      if (message.bytes) payload.bytes = message.bytes;
      port.postMessage(payload);
    } catch (err) {
      cleanup();
      resolve({ ok: false, reason: err?.message || String(err) });
    }
  });
}

async function downloadElements(job, elements, kind, signal) {
  const port = livePort();
  const saved = [];
  const wantedQuality = kind === "video"
    ? (job.params?.downloadVideoQuality === "1080p" ? [/1080p/i, /720p/i] : job.params?.downloadVideoQuality === "480p" ? [/480p/i, /360p/i, /720p/i] : [/720p/i, /original/i])
    : (job.params?.downloadImageQuality === "4k" ? [/4k/i, /2k/i, /1k/i] : job.params?.downloadImageQuality === "2k" ? [/2k/i, /1k/i] : [/1k/i, /original/i]);
  for (let i = 0; i < elements.length; i++) {
    throwIfAborted(signal);
    const el = elements[i];
    const label = nearbyLabel(el) || norm(job.prompt).slice(0, 70) || "output";
    const filename = resultName(job, i + 1, label, kind === "video" ? "mp4" : "png");
    clickEl(el);
    await sleep(200, signal);
    const clicked = await askDownload(port, {
      type: "arm",
      filename,
      afterArmed: async () => {
        const button = findDownloadNear(el) || findClickable(document, [/^download$/i, /^download image$/i, /^download video$/i]);
        if (!button) throw new StepError("no Download control on the result");
        clickEl(button);
        await sleep(300, signal);
        const quality = findMenuItem(wantedQuality) || findClickable(document, wantedQuality);
        if (quality) clickEl(quality);
      }
    }, signal);
    if (clicked.ok && clicked.path) {
      saved.push(fileRecord(clicked.path, kind, label));
      continue;
    }
    const url = mediaKey(el);
    let direct = { ok: false, reason: clicked.reason };
    if (url.startsWith("http")) {
      direct = await askDownload(port, { type: "download", url, filename }, signal);
    } else if (url.startsWith("blob:")) {
      const blob = await fetch(url).then((res) => res.blob());
      direct = await askDownload(port, { type: "download", bytes: await blob.arrayBuffer(), mime: blob.type, filename }, signal);
    }
    if (!direct.ok || !direct.path) {
      throw new StepError(direct.reason || clicked.reason || "could not find a Download control or a media URL for the result");
    }
    const record = fileRecord(direct.path, kind, label);
    record.note = "saved from the on-page media because the Download menu did not start a file";
    saved.push(record);
  }
  return saved;
}

function findDownloadNear(el) {
  let parent = el;
  for (let i = 0; i < 6 && parent; i++) {
    const button = findClickable(parent, [/^download$/i, /^download image$/i, /^download video$/i]);
    if (button) return button;
    parent = parent.parentElement;
  }
  return null;
}

function fileRecord(path, kind, label) {
  const record = { path, kind };
  if (label) record.label = label;
  return record;
}

function livePort() {
  if (!live?.port) throw new StepError("lost the connection to the extension worker");
  return live.port;
}

function base64ToBytes(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function preparePage(job, attempt, signal) {
  dismissNoise();
  if (job.mode === "flow-extend-video" || job.mode === "flow-set-voice" || job.mode === "flow-rename-asset") return null;
  if (job.params?.newProject) {
    const button = findClickable(document, [/^new project$/i, /^create with flow$/i]);
    if (!button && attempt < 2) return { needHome: true };
    if (!button) throw new StepError("could not find a New project control on flow.google.com");
    clickEl(button);
    await waitFor(() => findPrompt(), 20000, "the prompt box in the new project", signal);
    return null;
  }
  if (findPrompt()) return null;
  if (/\/(project|character)\//.test(location.pathname)) {
    await sleep(400, signal);
    if (findPrompt() || job.mode === "flow-create-character") return null;
  }
  const link = queryAllDeep('a[href*="/project/"]').find(visible);
  if (link) {
    clickEl(link);
    await waitFor(() => findPrompt(), 15000, "a prompt box after opening a project", signal);
    return null;
  }
  const created = findClickable(document, [/^new project$/i]);
  if (created) {
    clickEl(created);
    await waitFor(() => findPrompt(), 20000, "the prompt box", signal);
    return null;
  }
  throw new StepError("no Flow project is open and there is no New project control. Open a project on flow.google.com.");
}

async function fillField(patterns, text, signal, notes, what) {
  const labelled = queryAllDeep("input, textarea, [contenteditable='true']").find((el) => {
    if (!visible(el)) return false;
    const hint = `${labelOf(el)} ${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""}`;
    return patterns.some((pattern) => pattern.test(hint));
  });
  const field = labelled || findClickable(document, patterns);
  if (!field) {
    notes.push(`could not find the ${what} field`);
    return false;
  }
  const target = field.matches?.("input, textarea, [contenteditable='true']") ? field : field.querySelector?.("input, textarea, [contenteditable='true']") || field;
  await setEditorText(target, text);
  await sleep(150, signal);
  return true;
}

async function attachVoice(job, signal, notes) {
  if (job.params?.voiceStyle && layoutOf() === "narrow") {
    throw new StepError("The Flow window is narrow, so Customize performance is not on the page. Maximise the Flow window and run this again.");
  }
  let select = findClickable(document, [/select a voice/i, /^add voices?$/i]);
  if (!select) {
    const remove = findClickable(document, [/remove voice/i]);
    if (remove) {
      clickEl(remove);
      await sleep(400, signal);
      select = findClickable(document, [/select a voice/i, /^add voices?$/i]);
    }
  }
  if (!select) throw new StepError("could not find Select a voice. Open the character editor and maximise the window.");
  clickEl(select);
  await sleep(350, signal);
  const voice = job.params?.voiceName;
  if (job.params?.voiceStyle) {
    const create = findClickable(document, [/create new voice/i, /customize performance/i, /voice performance/i]);
    if (create) clickEl(create);
    await sleep(200, signal);
    if (voice) {
      const preset = findClickable(document, [new RegExp(`^${escapeReg(voice)}$`, "i"), new RegExp(escapeReg(voice), "i")]);
      if (preset) clickEl(preset);
      else notes.push(`could not find the voice preset "${voice}"`);
    }
    await fillField([/voice performance/i, /customize performance/i], job.params.voiceStyle, signal, notes, "voice performance");
    if (job.params?.voiceSaveAs) await fillField([/^name$/i, /voice name/i], job.params.voiceSaveAs, signal, notes, "voice name");
    const save = findClickable(document, [/save new voice/i]);
    if (!save) throw new StepError("could not find Save New Voice");
    clickEl(save);
    await sleep(1500, signal);
  } else if (voice) {
    const preset = findClickable(document, [new RegExp(escapeReg(voice), "i")]);
    if (!preset) throw new StepError(`could not find a voice named "${voice}"`);
    clickEl(preset);
    await sleep(200, signal);
  }
  const add = findClickable(document, [/add to character/i]);
  if (add) clickEl(add);
  else notes.push("could not find Add to Character after picking the voice");
}

async function openCharacter(name, signal) {
  const characters = findClickable(document, [/^characters$/i]);
  if (!characters) throw new StepError("could not find the Characters control. Maximise the Flow window — Flow hides it in the narrow layout.");
  clickEl(characters);
  await sleep(400, signal);
  const card = findClickable(document, [new RegExp(`^${escapeReg(name)}$`, "i")]) || findLabelElement(name);
  if (!card) throw new StepError(`could not find a character named "${name}"`);
  clickEl(card);
  await sleep(400, signal);
}

async function createCharacter(job, signal, progress) {
  if (job.params?.voiceStyle && layoutOf() === "narrow") {
    throw new StepError("The Flow window is narrow, so Customize performance is not on the page. Maximise the Flow window and run this again.");
  }
  const notes = [];
  progress("applying-mode", "Characters");
  const characters = findClickable(document, [/^characters$/i]);
  if (!characters) throw new StepError("could not find the Characters control. Maximise the Flow window — Flow hides it in the narrow layout.");
  clickEl(characters);
  await sleep(400, signal);
  const name = job.params?.characterName;
  if (name && findClickable(document, [new RegExp(`^${escapeReg(name)}$`, "i")])) {
    return {
      files: [],
      warning: `character "${name}" already exists in this project — nothing was generated. Cast it with --asset "${name}", or pass a different --name to make a second one.`
    };
  }
  const newer = findClickable(document, [/^new character$/i]);
  if (newer) clickEl(newer);
  await sleep(300, signal);
  progress("entering-prompt", "Describing the character");
  const prompt = findPrompt();
  if (!prompt) throw new StepError("could not find the character prompt box");
  await setEditorText(prompt, job.prompt);
  const before = snapshot();
  progress("submitting", "Generate");
  await submit(signal);
  progress("generating", "Waiting for the portrait");
  await waitForResults(before, "image", job, signal, 4 * 60 * 1000);
  progress("applying-settings", "Name, voice, and info");
  if (name) await fillField([/character name/i, /^name$/i], name, signal, notes, "character name");
  if (job.params?.characterInfo) await fillField([/character info/i], job.params.characterInfo, signal, notes, "character info");
  if (job.params?.voiceName) await attachVoice(job, signal, notes);
  if (job.params?.bodyPrompt) {
    const body = findClickable(document, [/create body/i]);
    if (!body) notes.push("could not find Create Body");
    else {
      clickEl(body);
      await sleep(300, signal);
      const bodyPrompt = findPrompt();
      if (!bodyPrompt) throw new StepError("Create Body did not show a prompt box");
      await setEditorText(bodyPrompt, job.params.bodyPrompt);
      const bodyBefore = snapshot();
      await submit(signal);
      progress("generating", "Waiting for the body sheet");
      await waitForResults(bodyBefore, "image", job, signal, 4 * 60 * 1000);
    }
  }
  const done = findClickable(document, [/^done$/i, /^save$/i]);
  if (done) clickEl(done);
  return { files: [], warning: notes.filter(Boolean).join(" ") || undefined };
}

async function setVoice(job, signal, progress) {
  const notes = [];
  progress("applying-mode", "Opening the character");
  const name = job.characterRefs?.[0];
  if (name) await openCharacter(name, signal);
  else if (!/\/character\//.test(location.pathname)) {
    throw new StepError('flow-set-voice needs the character open. Pass --character "Name", or open the character so the address contains /character/<id>.');
  }
  progress("applying-settings", job.params?.voiceName || "Voice");
  if (!job.params?.voiceName) throw new StepError("flow-set-voice needs a voice name");
  await attachVoice(job, signal, notes);
  if (job.params?.characterName) await fillField([/character name/i, /^name$/i], job.params.characterName, signal, notes, "character name");
  const done = findClickable(document, [/^done$/i, /^save$/i]);
  if (done) clickEl(done);
  return { files: [], warning: notes.filter(Boolean).join(" ") || undefined };
}

async function renameAsset(job, signal, progress) {
  const currentName = job.assetRefs?.[0];
  const nextName = job.params?.characterName;
  if (!currentName || !nextName) throw new StepError('flow-rename-asset needs both the current asset name and the new name');
  progress("preparing-page", `Finding "${currentName}"`);
  const label = findLabelElement(currentName);
  if (!label) throw new StepError(`could not find an asset whose label contains "${currentName}"`);
  progress("applying-mode", "Opening the asset menu");
  let menu = null;
  let parent = label;
  for (let i = 0; i < 5 && parent; i++) {
    menu = findClickable(parent, [/more options/i, /^more$/i, /^menu$/i, /^rename$/i]);
    if (menu) break;
    parent = parent.parentElement;
  }
  if (!menu) throw new StepError("could not find the asset menu");
  if (!/^rename$/i.test(labelOf(menu))) {
    clickEl(menu);
    await sleep(300, signal);
  }
  const rename = findClickable(document, [/^rename$/i]);
  if (!rename) throw new StepError("no Rename item in its menu");
  clickEl(rename);
  await sleep(300, signal);
  progress("entering-prompt", "Typing the new name");
  const field = queryAllDeep("input, textarea, [contenteditable='true']").find((el) => visible(el) && !el.readOnly);
  if (!field) throw new StepError("never showed a text field");
  await setEditorText(field, nextName);
  const save = findClickable(document, [/^rename$/i, /^save$/i, /^done$/i]);
  if (!save) throw new StepError("could not find a control to confirm the rename");
  clickEl(save);
  return { files: [] };
}

async function uploadAssets(job, files, signal, progress) {
  if (!files.length) throw new StepError("flow-upload-assets needs at least one file");
  progress("attaching-images", `Uploading ${files.length} file(s)`);
  for (let offset = 0; offset < files.length; offset += 50) {
    const input = await revealFileInput(signal);
    if (!input) throw new StepError("could not find a file input. Looked for Upload, Add, and input[type=file].");
    setInputFiles(input, files.slice(offset, offset + 50).map(toFile));
    await sleep(700, signal);
  }
  progress("collecting-results", "Waiting until Flow lists the uploads");
  const names = files.map((file) => file.name).filter(Boolean);
  await waitFor(
    () => names.every((name) => (document.body?.innerText || "").toLowerCase().includes(name.toLowerCase())),
    90000,
    "the uploaded filenames listed in the project",
    signal
  );
  return { files: [] };
}

function extendBeats(job) {
  if (job.params?.extendSteps?.length) return job.params.extendSteps;
  const count = job.params?.autoExtendCount > 0 ? job.params.autoExtendCount : 1;
  const text = job.params?.extendPrompt || job.prompt;
  return Array.from({ length: count }, () => text);
}

async function extendVideo(job, signal, progress) {
  if (!/\/project\/[^/]+\/edit\//.test(location.pathname)) {
    throw new StepError("flow-extend-video needs the clip open in Flow's editor. The address should contain /project/<id>/edit/<clip>. Open the video, then run this again.");
  }
  const beats = extendBeats(job);
  let warning = "";
  let completed = 0;
  for (let i = 0; i < beats.length; i++) {
    progress("applying-mode", `Extend ${i + 1} of ${beats.length}`);
    const control = findClickable(document, [/extend \(veo/i, /^extend$/i, /extend video/i]);
    const disabled = control && (control.getAttribute("aria-disabled") === "true" || control.disabled);
    if (!control || disabled) {
      const reason = disabled
        ? "Extend is disabled. Flow only extends Veo 3.1 clips, and the control is off for Omni Flash."
        : "no Extend control — Flow only shows it on a Veo 3.1 clip. Omni Flash clips cannot be extended.";
      if (!completed) throw new StepError(reason);
      warning = `stopped after ${completed} extend(s): ${reason}`;
      break;
    }
    clickEl(control);
    await sleep(300, signal);
    progress("entering-prompt", norm(beats[i]).slice(0, 80));
    const prompt = findPrompt();
    if (!prompt) throw new StepError("could not find the extend prompt box");
    await setEditorText(prompt, beats[i]);
    const before = snapshot();
    progress("submitting", "Generate");
    await submit(signal);
    progress("generating", `Waiting for extend ${i + 1}`);
    try {
      await waitForResults(before, "video", job, signal, 12 * 60 * 1000);
      completed++;
    } catch (err) {
      if (!completed) throw err;
      warning = `stopped after ${completed} extend(s): ${err.message}`;
      break;
    }
  }
  progress("collecting-results", "Finding the extended clip");
  progress("downloading", "Saving the extended clip");
  const video = largeMedia().filter((el) => el.tagName === "VIDEO").pop() || largeMedia().pop();
  if (!video) {
    if (warning) return { files: [], warning };
    throw new StepError("the extend finished but no clip was on the page to download");
  }
  const files = await downloadElements(job, [video], "video", signal);
  return { files, warning: warning || undefined };
}

async function runGeneration(job, files, signal, progress) {
  const notes = [];
  if ((job.characterRefs || []).length && (job.mode === "flow-frame-to-video" || job.mode === "flow-extend-video")) {
    throw new StepError(`character references do not work with ${job.mode}`);
  }
  const refs = files.length + (job.assetRefs?.length || 0);
  if (job.mode === "flow-image-to-image" && !refs) throw new StepError("flow-image-to-image needs an image file or an asset already in the project");
  if (job.mode === "flow-frame-to-video" && !refs) throw new StepError("flow-frame-to-video needs a start frame");
  if (job.mode === "flow-video-to-video" && !refs) throw new StepError("flow-video-to-video needs one clip, as a file or an asset already in the project");
  if (job.mode === "flow-ingredients-to-video" && !refs && !(job.characterRefs || []).length) {
    throw new StepError("flow-ingredients-to-video needs a reference image, a video, or an asset already in the project");
  }
  progress("applying-mode", job.mode);
  await applyMode(job.mode, signal);
  progress("applying-settings", "Model, shape, count, length");
  notes.push(...await applySettings(job, signal));
  if (refs) {
    progress("attaching-images", "Adding references");
    if (job.mode === "flow-frame-to-video") await attachFrames(job, files, signal);
    else await attachGeneric(files, job.assetRefs, signal);
  }
  progress("entering-prompt", "Typing the prompt");
  const prompt = findPrompt();
  if (!prompt) throw new StepError("could not find the Flow prompt box (looked for textarea, contenteditable, and role=textbox)");
  await setEditorText(prompt, composedPrompt(job));
  const before = snapshot();
  progress("submitting", "Generate");
  await submit(signal);
  const kind = kindOf(job.mode);
  progress("generating", `Waiting for the ${kind}`);
  const fresh = await waitForResults(before, kind, job, signal, kind === "image" ? 4 * 60 * 1000 : 12 * 60 * 1000);
  const wanted = Math.max(1, Math.min(4, job.params?.outputsPerPrompt || 1));
  const chosen = fresh.slice(-wanted);
  if (chosen.length < wanted) notes.push(`Flow showed ${chosen.length} of ${wanted} outputs`);
  progress("collecting-results", `Found ${chosen.length}`);
  progress("downloading", "Saving to Downloads");
  const saved = await downloadElements(job, chosen, kind, signal);
  return { files: saved, warning: notes.filter(Boolean).join(" ") || undefined };
}

async function runJob(job, files, attempt, signal, progress) {
  throwIfAborted(signal);
  progress("preparing-page", "Getting the Flow page ready");
  const prep = await preparePage(job, attempt, signal);
  if (prep?.needHome) return prep;
  switch (job.mode) {
    case "flow-text-to-image":
    case "flow-image-to-image":
    case "flow-text-to-video":
    case "flow-frame-to-video":
    case "flow-ingredients-to-video":
    case "flow-video-to-video":
      return runGeneration(job, files, signal, progress);
    case "flow-create-character":
      return createCharacter(job, signal, progress);
    case "flow-set-voice":
      return setVoice(job, signal, progress);
    case "flow-extend-video":
      return extendVideo(job, signal, progress);
    case "flow-rename-asset":
      return renameAsset(job, signal, progress);
    case "flow-upload-assets":
      return uploadAssets(job, files, signal, progress);
    default:
      throw new StepError(`this extension does not run mode "${job.mode}"`);
  }
}

install();
})();
