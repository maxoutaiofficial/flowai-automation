// Excerpt from flow-mcp src/chrome.ts (https://github.com/GTAI-1/flow-mcp).
// Upstream package.json license: ISC. Author field empty; no LICENSE file shipped.
// Keep this header. The ISC permission notice is in NOTICE.
//
// Only the home directory and the Chrome executable lookup are included.
// Captions draw lettering in a headless Chrome. The dedicated Flow profile,
// remote-debugging port, and sign-in launcher are not part of this port.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME_DIR = process.env.FLOW_MCP_HOME ?? join(homedir(), ".flow-mcp");

const CHROME_PATHS = [
  process.env.FLOW_MCP_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  // Windows also installs Chrome here: 32-bit builds, and per-user installs made without admin rights.
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
].filter((p): p is string => Boolean(p));

export function chromeExecutable(): string {
  const chromePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!chromePath) throw new Error("Google Chrome not found. Set FLOW_MCP_CHROME to the Chrome executable path.");
  return chromePath;
}
