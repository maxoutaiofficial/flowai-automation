// Licensed under the MIT License by MaxOut AI. You may use, modify, and redistribute this code if you keep this copyright notice and the MIT license terms.
const source = document.getElementById("setup-source");
const promptEl = document.getElementById("prompt");
const setupView = document.getElementById("setup");
const statusView = document.getElementById("status-view");
const showSetup = document.getElementById("show-setup");
const showStatus = document.getElementById("show-status");
const copyBtn = document.getElementById("copy");
const line = document.getElementById("line");
const gate = document.getElementById("gate");
const bridge = document.getElementById("bridge");
const tab = document.getElementById("tab");
const layout = document.getElementById("layout");
const jobs = document.getElementById("jobs");

const promptText = (source && source.textContent ? source.textContent : "").replace(/^\n/, "").replace(/\s+$/, "");
promptEl.textContent = promptText;

function select(which) {
  const setupOn = which === "setup";
  setupView.hidden = !setupOn;
  statusView.hidden = setupOn;
  showSetup.setAttribute("aria-selected", setupOn ? "true" : "false");
  showStatus.setAttribute("aria-selected", setupOn ? "false" : "true");
}

showSetup.addEventListener("click", () => select("setup"));
showStatus.addEventListener("click", () => select("status"));
select("setup");

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(promptText);
    copyBtn.textContent = "Copied";
  } catch (_err) {
    const range = document.createRange();
    range.selectNodeContents(promptEl);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    copyBtn.textContent = "Selected — copy it";
  }
  setTimeout(() => {
    copyBtn.textContent = "Copy prompt";
  }, 1600);
});

function fillPage(status) {
  tab.textContent = !status.flowTab ? "none" : status.grokVisible ? "visible" : "hidden";
  layout.textContent = status.flowLayout || "unknown";
  jobs.textContent = String(status.activeJobs ?? 0);
}

chrome.runtime.sendMessage({ type: "popup-status" }, (status) => {
  if (chrome.runtime.lastError || !status) {
    line.textContent = "Extension worker is not answering.";
    bridge.textContent = "down";
    return;
  }
  if (status.subscription === "unsubscribed") {
    line.textContent = "Subscribe to the channel to use this extension.";
    gate.hidden = false;
    gate.replaceChildren();
    const link = document.createElement("a");
    link.href = status.channelUrl || "https://www.youtube.com/channel/UCf81rjZnBT9mo_PCXds62BQ";
    link.textContent = link.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    gate.appendChild(link);
    bridge.textContent = "blocked";
    fillPage(status);
    return;
  }
  gate.hidden = true;
  bridge.textContent = status.connected ? "connected" : "not connected";
  line.textContent = status.connected
    ? "Talking to the bridge on this computer."
    : status.lastError || "Start the Flow Connector CLI so the bridge is listening.";
  fillPage(status);
});
