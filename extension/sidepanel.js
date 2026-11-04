// Licensed under the MIT License by MaxOut AI. You may use, modify, and redistribute this code if you keep this copyright notice and the MIT license terms.
const promptBox = document.getElementById("setup-prompt");
const copyButton = document.getElementById("copy");
const copied = document.getElementById("copied");

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

if (copyButton && promptBox) {
  copyButton.addEventListener("click", () => {
    const text = (promptBox.value || promptBox.textContent || "").replace(/^\n/, "").trim();
    const mark = (message) => {
      if (!copied) return;
      copied.hidden = false;
      copied.textContent = message;
    };
    const fallback = () => {
      try {
        const range = document.createRange();
        range.selectNodeContents(promptBox);
        const sel = getSelection();
        if (!sel) {
          mark("Select the prompt and copy it.");
          return;
        }
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("copy");
        mark("Copied.");
      } catch (err) {
        console.error("copy failed", err);
        mark("Select the prompt and copy it.");
      }
    };
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
      fallback();
      return;
    }
    navigator.clipboard.writeText(text).then(() => mark("Copied.")).catch(() => fallback());
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

showTab("setup");
