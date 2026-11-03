// Ported from flow-mcp (https://github.com/GTAI-1/flow-mcp).
// Upstream package.json license: ISC. The author field was empty and no LICENSE file shipped.
// Keep this header. The ISC permission notice is in NOTICE beside this directory's source.

import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { FFMPEG_HINT } from "./platform.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";

// Saves the final frame of a clip so the next scene can start exactly where this one ended.
export async function extractLastFrame(video: string, out?: string): Promise<string> {
  const dest = out ?? video.replace(/\.\w+$/, "") + "-lastframe.jpg";
  mkdirSync(dirname(dest), { recursive: true });
  try {
    await run(FFMPEG, ["-y", "-sseof", "-0.2", "-i", video, "-update", "1", "-q:v", "2", dest]);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT})` : String(err);
    throw new Error(`chain_previous needs ffmpeg to grab the previous clip's last frame: ${reason}`);
  }
  return dest;
}
