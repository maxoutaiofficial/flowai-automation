// Flow Connector wiring. The last-frame grab is the ported extractLastFrame.
// Generation is handed to the installed flow-auto CLI, which drives the
// Flow Connector extension. flow-mcp's agent-mode continue (dedicated Chrome
// profile, Save frame, Animate, character chip) is not included.

import { spawn } from "node:child_process";

import { extractLastFrame } from "./chain.js";

export type ContinueMode = "exact" | "likeness";

export interface ContinueRequest {
  video: string;
  prompt?: string;
  mode: ContinueMode;
  assets: string[];
  aspectRatio?: "16:9" | "9:16";
  model?: string;
  duration?: string;
  wait: boolean;
  waitTimeout?: string;
  /** Jpeg path for the last frame. Default: the clip's path with -lastframe.jpg. */
  frame?: string;
  run: boolean;
}

export interface ContinuePlan {
  last_frame: string;
  mode: ContinueMode;
  ran: boolean;
  exit_code?: number;
  flow_auto: string[] | null;
  note: string;
}

const EXACT_NOTE =
  "exact opens the next clip on this last frame via flow-frame-to-video. Attached characters are ignored: Flow's frame composer cannot hold a character and a start frame together.";

const LIKENESS_NOTE =
  "likeness keeps each --asset character attached via flow-ingredients-to-video, with this last frame as an image reference. The opening frame is only approximate. Flow cannot lock a character and match the frame exactly at the same time.";

export function flowAutoArgs(req: ContinueRequest, lastFrame: string): string[] | null {
  if (!req.prompt) return null;
  if (req.mode === "exact" && req.assets.length) {
    throw new Error(
      "mode exact cannot attach a character. Flow's frame composer ignores extra references. Re-run with --mode likeness to keep the character, knowing the opening frame will only be approximate.",
    );
  }
  const args = ["generate", "create", req.mode === "exact" ? "flow-frame-to-video" : "flow-ingredients-to-video", "--prompt", req.prompt, "--image", lastFrame];
  if (req.mode === "likeness") {
    for (const name of req.assets) args.push("--asset", name);
  }
  if (req.aspectRatio) args.push("--aspect-ratio", req.aspectRatio);
  if (req.model) args.push("--model", req.model);
  if (req.duration) args.push("--duration", req.duration);
  if (req.wait) args.push("--wait");
  if (req.waitTimeout) args.push("--wait-timeout", req.waitTimeout);
  return args;
}

export async function continueShot(req: ContinueRequest): Promise<ContinuePlan> {
  const last_frame = await extractLastFrame(req.video, req.frame);
  const flow_auto = flowAutoArgs(req, last_frame);
  const bin = process.env.FLOW_AUTO ?? "flow-auto";
  const command = flow_auto ? [bin, ...flow_auto] : null;
  const note = `${req.mode === "exact" ? EXACT_NOTE : LIKENESS_NOTE} ${
    flow_auto
      ? "Pass --run to execute that flow-auto command. Without --run nothing is generated and no Flow credits are spent."
      : "No prompt was given, so only the last frame was saved. flow-extend-video is a different tool: it lengthens the Veo clip already open in Flow."
  }`;
  if (!req.run || !flow_auto) {
    return { last_frame, mode: req.mode, ran: false, flow_auto: command, note };
  }
  const child = spawn(bin, flow_auto, { stdio: "inherit" });
  const exit_code = await new Promise<number>((resolve, reject) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error(`flow-auto is not on PATH (${bin}). The last frame is at ${last_frame}. Install the Flow Connector CLI, then re-run with --run. Generation was not started.`));
        return;
      }
      reject(err);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
  return {
    last_frame,
    mode: req.mode,
    ran: true,
    exit_code,
    flow_auto: command,
    note,
  };
}
