// Licensed under the MIT License by MaxOut AI. You may use, modify, and redistribute this code if you keep this copyright notice and the MIT license terms.
const line = document.getElementById("line");
const gate = document.getElementById("gate");
const bridge = document.getElementById("bridge");
const tab = document.getElementById("tab");
const layout = document.getElementById("layout");
const jobs = document.getElementById("jobs");

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
