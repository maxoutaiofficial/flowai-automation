// Licensed under the MIT License by MaxOut AI. You may use, modify, and redistribute this code if you keep this copyright notice and the MIT license terms.
const COPY_LABEL = "Copy prompt";

function showTab(name) {
  for (const id of ["setup", "home", "help"]) {
    const panel = document.getElementById("panel-" + id);
    const tabButton = document.querySelector('[data-tab="' + id + '"]');
    const on = id === name;
    if (panel) panel.hidden = !on;
    if (tabButton) {
      tabButton.classList.toggle("active", on);
      tabButton.setAttribute("aria-selected", on ? "true" : "false");
    }
  }
}

document.querySelectorAll("[data-tab]").forEach((button) => {
  button.addEventListener("click", () => showTab(button.getAttribute("data-tab") || "setup"));
});

function copyWithFallback(text) {
  return new Promise((resolve, reject) => {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.setAttribute("aria-hidden", "true");
    area.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(area);
    let ok = false;
    try {
      area.focus();
      area.select();
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    } finally {
      area.remove();
    }
    if (ok) resolve();
    else reject(new Error("copy failed"));
  });
}

function copyPrompt(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    return navigator.clipboard.writeText(text).catch(() => copyWithFallback(text));
  }
  return copyWithFallback(text);
}

const copyButton = document.getElementById("copy");
if (copyButton) {
  copyButton.addEventListener("click", () => {
    const text = typeof SETUP_PROMPT === "string" ? SETUP_PROMPT : "";
    copyPrompt(text).then(() => {
      copyButton.textContent = "Copied";
      setTimeout(() => {
        copyButton.textContent = COPY_LABEL;
      }, 1600);
    }).catch(() => {
      copyButton.textContent = "Copy failed";
      setTimeout(() => {
        copyButton.textContent = COPY_LABEL;
      }, 1600);
    });
  });
}

function fillPage(status) {
  const tab = document.getElementById("tab");
  const layout = document.getElementById("layout");
  const jobs = document.getElementById("jobs");
  if (tab) tab.textContent = !status.flowTab ? "none" : status.grokVisible ? "visible" : "hidden";
  if (layout) layout.textContent = status.flowLayout || "unknown";
  if (jobs) jobs.textContent = String(status.activeJobs ?? 0);
}

function refreshStatus() {
  if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") return;
  try {
    chrome.runtime.sendMessage({ type: "popup-status" }, (status) => {
      const line = document.getElementById("line");
      const gate = document.getElementById("gate");
      const bridge = document.getElementById("bridge");
      if (chrome.runtime.lastError || !status) {
        if (line) line.textContent = "Extension worker is not answering.";
        if (bridge) bridge.textContent = "down";
        return;
      }
      if (status.subscription === "unsubscribed") {
        if (line) line.textContent = "Subscribe to the channel to use this extension.";
        if (gate) {
          gate.hidden = false;
          gate.replaceChildren();
          const link = document.createElement("a");
          link.href = status.channelUrl || "https://www.youtube.com/channel/UCf81rjZnBT9mo_PCXds62BQ";
          link.textContent = link.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          gate.appendChild(link);
        }
        if (bridge) bridge.textContent = "blocked";
        fillPage(status);
        return;
      }
      if (gate) gate.hidden = true;
      if (bridge) bridge.textContent = status.connected ? "connected" : "not connected";
      if (line) {
        line.textContent = status.connected
          ? "Talking to the bridge on this computer."
          : status.lastError || "Start the Flow Connector CLI so the bridge is listening.";
      }
      fillPage(status);
    });
  } catch {
    /* Setup stays visible if the bridge status call fails. */
  }
}

refreshStatus();
showTab("setup");
