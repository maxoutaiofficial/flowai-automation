#!/usr/bin/env node
// Flow Connector command wrapper for the ISC flow-mcp port in this directory.
// See NOTICE. This file is the wiring; the movie, music, caption, voice, and
// last-frame implementations are the ported modules.

import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { assemble, localVoices, speakLocally, voiceTrack, type VoiceLine } from "./assemble.js";
import { burnCaptions, captionedName, captionSetup, transcribe, type CaptionLetters, type CaptionOptions, type CaptionPosition, type CaptionSize, type CaptionStyle } from "./captions.js";
import { continueShot, type ContinueMode } from "./continue-shot.js";
import { GEMINI_VOICES, geminiKey, speakWithGemini } from "./gemini.js";
import { COMPUTER, IS_MAC, IS_WIN } from "./platform.js";

const DEFAULT_TTS_MODEL = "gemini-2.5-flash-preview-tts";

const INTRO = `flow-movie — local film tools ported from flow-mcp (ISC). See NOTICE.

From the Flow Connector checkout: bin/flow-movie <command>
Same command name as the npm bin in vendor/flow-mcp-movie.

These commands do not open Google Flow. continue does not generate anything
unless you pass --run, and --run is off by default. --run calls the installed
flow-auto and can spend Flow credits. flow-extend-video is a different command.

flow-movie <command> --help prints that command's flags.
`;

const HELP_VOICES = `voices
  No flags. Prints Gemini voice names and this computer's English voices.
  Does not print a key.
`;

const HELP_NARRATE = `narrate — write a voiceover file
  --text <words>            required
  --engine gemini|mac       default gemini
  --voice <name>            default Charon for gemini. Required for mac (see voices).
  --style <delivery>        gemini only. Default: none. Sent as "Say <style>: <text>".
  --model <id>              gemini TTS model. Default ${DEFAULT_TTS_MODEL}
                            (or FLOW_MCP_GEMINI_TTS when --model is omitted).
  --rate <wpm>              macOS say speed. Default 168. Range 50 to 400.
                            Not used by gemini. Windows has no rate control.
  --out <file>              output path. Default ./narration.m4a

  bin/flow-movie narrate --text "The boat keeps drifting." --voice Kore --out narration.m4a
`;

const HELP_ASSEMBLE = `assemble — join clips, a music bed, and a voiceover
  --dir <folder>            required. The film is written here.
  --clip <file>             repeatable. Default: numbered scene/clip/edit mp4s in
                            --dir, else every other mp4, oldest first. Skips
                            narration-*.mp4 and the output file.
  --music <file>            music path, looped under the film. Default: none.
  --music-volume <0-1>      music volume. Default 0.25.
  --clip-volume <0-1>       clip-audio volume. Default 1.
  --voiceover <file>        voiceover path, laid on top. Default: none.
  --voice-volume <0-1>      voiceover volume. Default 1.
                            --voice-lines replaces --voiceover when both are set.
  --voice-lines <file.json> JSON array of {file, at, from?, to?, max_seconds?}.
                            Default: none.
  --output <name>           output path name inside --dir. Default final → final.mp4.
  --hold-pad <seconds>      extra seconds after the voiceover when the last frame
                            is held. Default 0.6. Range 0 to 120. Ignored with --no-hold.
  --no-hold                 do not hold the last frame. Default: hold is on when a
                            voiceover is longer than the clips.

  bin/flow-movie assemble --dir ./film --clip a.mp4 --clip b.mp4 --music bed.mp3 --music-volume 0.25 --clip-volume 0.4 --voiceover narration.m4a --output final
`;

const HELP_TRANSCRIBE = `transcribe <video>
  --language <code>         whisper code (en, es, ja, ...) or auto. Default auto.
  --no-words                print the transcript only. Default: include each word's
                            start and end.

  bin/flow-movie transcribe scene.mp4 --language en
`;

const HELP_CAPTIONS = `captions <video> — burn captions and write a sibling .srt
  --style bold|highlight|reveal|clean|boxed
                            caption style. Default bold.
  --position bottom|middle|top|<0-100>
                            default bottom. A number is how far down the frame the
                            caption sits (0 top edge, 100 bottom edge).
  --size small|medium|large|<40-250>
                            default medium. A number is a percent of medium (100 = medium).
  --language <code>         caption language, same codes as transcribe. Default auto.
  --text <words>            corrected words. Timings stay on the words that still match.
                            Default: what whisper heard.
  --letters as_said|capitals|lowercase
                            default: bold uses capitals; every other style uses as_said.
  --name <word>             repeatable. That word keeps its capitals when --letters
                            lowercase. Default: none, plus names already capitalized
                            mid-sentence.
  --color <#RRGGBB>         default: bold #FFE135, highlight #7C3AED, reveal #FFFFFF,
                            clean #FFFFFF, boxed #FFFFFF.
  --lead <seconds>          how far the highlight runs ahead of the voice. Default 0.12.
                            Range -0.5 to 0.5.
  --out <file>              output path. Default <video-dir>/<stem>-captions.mp4,
                            then -captions-2, and so on, so nothing is overwritten.

  bin/flow-movie captions scene.mp4 --style bold --language en --position bottom --size medium --out scene-captions.mp4
`;

const HELP_CONTINUE = `continue <video> — save the last frame. Does not generate unless --run.
  --prompt <text>           what happens next. Default: none, and then only the frame is saved.
  --mode exact|likeness     continue mode. Default exact.
  --asset <name>            repeatable character name. likeness only. exact rejects --asset.
  --aspect-ratio 16:9|9:16  forwarded to flow-auto. Default: omitted (flow-auto's own default).
  --model <name>            flow-auto video model. Default: omitted.
  --duration <seconds>      forwarded to flow-auto. Default: omitted.
  --wait                    forwarded. Default: off.
  --wait-timeout <minutes>  forwarded. Default: omitted (flow-auto uses 15).
  --frame <file>            last-frame jpeg. Default: <video>-lastframe.jpg beside the clip.
  --run                     execute the printed flow-auto command. Default: off.
                            Off spends no Flow credits and does not open Flow.

  exact maps to:  flow-auto generate create flow-frame-to-video --image <lastframe> --prompt ...
  likeness maps to: flow-auto generate create flow-ingredients-to-video --image <lastframe> --asset <name> --prompt ...
  Likeness keeps the character and only approximates the opening frame.
  Exact opens on the frame and cannot attach a character.
  The binary is flow-auto, or whatever FLOW_AUTO names.

  bin/flow-movie continue scene.mp4 --prompt "she looks back" --mode likeness --asset "NARRATOR"
  Add --run only when that generation should spend Flow credits.
`;

const HELP_SETUP = `caption-setup
  No flags. Says whether whisper-cli and the speech models are present.
`;

const COMMAND_HELP: Record<string, string> = {
  voices: HELP_VOICES,
  narrate: HELP_NARRATE,
  assemble: HELP_ASSEMBLE,
  transcribe: HELP_TRANSCRIBE,
  captions: HELP_CAPTIONS,
  continue: HELP_CONTINUE,
  "caption-setup": HELP_SETUP,
};

const HELP = `${INTRO}
${HELP_VOICES}
${HELP_NARRATE}
${HELP_ASSEMBLE}
${HELP_TRANSCRIBE}
${HELP_CAPTIONS}
${HELP_CONTINUE}
${HELP_SETUP}`;

function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function flag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number from ${min} to ${max}.`);
  return n;
}

function wantsHelp(args: string[]): boolean {
  return args.some((arg) => arg === "--help" || arg === "-h");
}

function readVoiceLines(path: string): VoiceLine[] {
  const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(data) || data.length === 0) throw new Error("--voice-lines must be a non-empty JSON array.");
  return data.map((line, i) => {
    const row = line as Partial<VoiceLine>;
    if (!row || typeof row.file !== "string" || typeof row.at !== "number") {
      throw new Error(`Voice line ${i + 1} needs "file" and "at" (seconds).`);
    }
    return { file: row.file, from: row.from, to: row.to, at: row.at, max_seconds: row.max_seconds };
  });
}

const STYLES = new Set(["bold", "highlight", "reveal", "clean", "boxed"]);
const LETTERS = new Set(["as_said", "capitals", "lowercase"]);

function captionPosition(raw: string | undefined): CaptionPosition {
  if (raw === undefined || raw === "") return "bottom";
  if (raw === "bottom" || raw === "middle" || raw === "top") return raw;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error("--position must be bottom, middle, top, or a number from 0 to 100.");
  return n;
}

function captionSize(raw: string | undefined): CaptionSize {
  if (raw === undefined || raw === "") return "medium";
  if (raw === "small" || raw === "medium" || raw === "large") return raw;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 40 || n > 250) throw new Error("--size must be small, medium, large, or a number from 40 to 250.");
  return n;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || (command === "help" && rest.length === 0)) {
    process.stdout.write(HELP);
    return;
  }
  if (command === "help") {
    const page = COMMAND_HELP[rest[0] ?? ""];
    if (!page) throw new Error(`Unknown command "${rest[0]}". Run flow-movie --help.`);
    process.stdout.write(page);
    return;
  }
  if (COMMAND_HELP[command] && wantsHelp(rest)) {
    process.stdout.write(COMMAND_HELP[command]);
    return;
  }

  if (command === "voices") {
    const place = { computer: COMPUTER, local_engine: IS_MAC ? "macOS voice" : IS_WIN ? "Windows voice" : "System voice", platform: process.platform };
    process.stdout.write(`${JSON.stringify({ gemini: GEMINI_VOICES, gemini_ready: Boolean(geminiKey()), mac: await localVoices(), place }, null, 2)}\n`);
    return;
  }

  if (command === "caption-setup") {
    process.stdout.write(`${JSON.stringify(await captionSetup(), null, 2)}\n`);
    return;
  }

  if (command === "narrate") {
    const args = parseArgs({
      args: rest,
      strict: true,
      options: {
        text: { type: "string" },
        engine: { type: "string", default: "gemini" },
        voice: { type: "string" },
        style: { type: "string" },
        model: { type: "string" },
        rate: { type: "string" },
        out: { type: "string" },
      },
    });
    const text = flag(args.values.text)?.trim();
    if (!text) throw new Error("narrate needs --text.");
    const engine = flag(args.values.engine);
    if (engine !== "gemini" && engine !== "mac") throw new Error("--engine must be gemini or mac.");
    const style = flag(args.values.style);
    const modelArg = flag(args.values.model);
    const rateRaw = flag(args.values.rate);
    if (engine === "mac") {
      if (style) throw new Error("--style applies to --engine gemini.");
      if (modelArg) throw new Error("--model applies to --engine gemini. macOS uses the installed voice.");
      if (IS_WIN && rateRaw !== undefined) throw new Error("--rate is the macOS say speed. This computer's voice engine has no rate control.");
    } else if (rateRaw !== undefined) {
      throw new Error("--rate applies to --engine mac (words per minute). Gemini has no rate control.");
    }
    const voice = flag(args.values.voice) ?? (engine === "gemini" ? "Charon" : undefined);
    if (!voice) throw new Error("--engine mac needs --voice. Run flow-movie voices and pass one of those names.");
    const target = resolve(flag(args.values.out) ?? join(process.cwd(), "narration.m4a"));
    mkdirSync(join(target, ".."), { recursive: true });
    const ttsModel = modelArg ?? process.env.FLOW_MCP_GEMINI_TTS ?? DEFAULT_TTS_MODEL;
    if (engine === "gemini" && !/^[A-Za-z0-9._-]+$/.test(ttsModel)) {
      throw new Error("--model must be a Gemini model id such as gemini-2.5-flash-preview-tts.");
    }
    const spoken = engine === "mac"
      ? await speakLocally(text, voice, target, num("--rate", rateRaw, 168, 50, 400))
      : await speakWithGemini(text, voice, target, style, ttsModel);
    process.stdout.write(`${JSON.stringify({ credits: 0, engine, voice, ...spoken }, null, 2)}\n`);
    return;
  }

  if (command === "assemble") {
    const args = parseArgs({
      args: rest,
      strict: true,
      options: {
        dir: { type: "string" },
        clip: { type: "string", multiple: true },
        music: { type: "string" },
        "music-volume": { type: "string" },
        "clip-volume": { type: "string" },
        voiceover: { type: "string" },
        "voice-volume": { type: "string" },
        "voice-lines": { type: "string" },
        output: { type: "string", default: "final" },
        "hold-pad": { type: "string" },
        "no-hold": { type: "boolean", default: false },
      },
    });
    const dir = flag(args.values.dir);
    if (!dir) throw new Error("assemble needs --dir, the folder the film is written into.");
    const output_name = flag(args.values.output) ?? "final";
    const clips = args.values.clip?.map((c) => resolve(c));
    const music = flag(args.values.music);
    const music_volume = num("--music-volume", flag(args.values["music-volume"]), 0.25, 0, 1);
    const clip_volume = num("--clip-volume", flag(args.values["clip-volume"]), 1, 0, 1);
    const voice_volume = num("--voice-volume", flag(args.values["voice-volume"]), 1, 0, 1);
    const hold_pad = num("--hold-pad", flag(args.values["hold-pad"]), 0.6, 0, 120);
    let voiceover = flag(args.values.voiceover);
    let voice: Awaited<ReturnType<typeof voiceTrack>> | undefined;
    const linesPath = flag(args.values["voice-lines"]);
    if (linesPath) {
      const lines = readVoiceLines(resolve(linesPath));
      mkdirSync(resolve(dir), { recursive: true });
      const track = join(resolve(dir), `${output_name.replace(/[^\w.-]+/g, "_")}-voice.wav`);
      voice = await voiceTrack(lines, track);
      voiceover = voice.file;
    }
    const film = await assemble({
      dir: resolve(dir),
      clips,
      music: music ? resolve(music) : undefined,
      music_volume,
      clip_volume,
      voiceover: voiceover ? resolve(voiceover) : undefined,
      voice_volume,
      output_name,
      hold_last_frame: !args.values["no-hold"],
      hold_pad,
    });
    process.stdout.write(`${JSON.stringify(voice ? { ...film, voice } : film, null, 2)}\n`);
    return;
  }

  if (command === "transcribe") {
    const args = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: true,
      options: {
        language: { type: "string", default: "auto" },
        "no-words": { type: "boolean", default: false },
      },
    });
    const video = args.positionals[0];
    if (!video) throw new Error("transcribe needs a video or audio path.");
    const t = await transcribe(resolve(video), flag(args.values.language) ?? "auto");
    const words = !args.values["no-words"];
    process.stdout.write(
      `${JSON.stringify(
        {
          text: t.text,
          word_count: t.words.length,
          language: t.language,
          model: t.model,
          ...(words ? { words: t.words.map((w) => ({ text: w.text, start: Number(w.start.toFixed(2)), end: Number(w.end.toFixed(2)) })) } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (command === "captions") {
    const args = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: true,
      options: {
        style: { type: "string", default: "bold" },
        position: { type: "string" },
        size: { type: "string" },
        language: { type: "string", default: "auto" },
        text: { type: "string" },
        letters: { type: "string" },
        name: { type: "string", multiple: true },
        color: { type: "string" },
        lead: { type: "string" },
        out: { type: "string" },
      },
    });
    const video = args.positionals[0];
    if (!video) throw new Error("captions needs a video path.");
    const style = flag(args.values.style) ?? "bold";
    if (!STYLES.has(style)) throw new Error("--style must be bold, highlight, reveal, clean, or boxed.");
    const letters = flag(args.values.letters);
    if (letters && !LETTERS.has(letters)) throw new Error("--letters must be as_said, capitals, or lowercase.");
    const color = flag(args.values.color);
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("--color must be #RRGGBB.");
    const names = args.values.name?.map((n) => n.trim()).filter(Boolean);
    const options: CaptionOptions = {
      style: style as CaptionStyle,
      position: captionPosition(flag(args.values.position)),
      size: captionSize(flag(args.values.size)),
      language: flag(args.values.language) ?? "auto",
      text: flag(args.values.text),
      letters: letters as CaptionLetters | undefined,
      names: names && names.length ? names : undefined,
      color,
      lead: num("--lead", flag(args.values.lead), 0.12, -0.5, 0.5),
    };
    const source = resolve(video);
    const output = flag(args.values.out) ? resolve(flag(args.values.out)!) : captionedName(resolve(source, ".."), source);
    mkdirSync(join(output, ".."), { recursive: true });
    process.stdout.write(`${JSON.stringify(await burnCaptions(source, options, output), null, 2)}\n`);
    return;
  }

  if (command === "continue") {
    const args = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: true,
      options: {
        prompt: { type: "string" },
        mode: { type: "string", default: "exact" },
        asset: { type: "string", multiple: true },
        "aspect-ratio": { type: "string" },
        model: { type: "string" },
        duration: { type: "string" },
        wait: { type: "boolean", default: false },
        "wait-timeout": { type: "string" },
        frame: { type: "string" },
        run: { type: "boolean", default: false },
      },
    });
    const video = args.positionals[0];
    if (!video) throw new Error("continue needs the clip to take the last frame from.");
    const mode = flag(args.values.mode) ?? "exact";
    if (mode !== "exact" && mode !== "likeness") throw new Error("--mode must be exact or likeness.");
    const aspect = flag(args.values["aspect-ratio"]);
    if (aspect && aspect !== "16:9" && aspect !== "9:16") throw new Error("--aspect-ratio must be 16:9 or 9:16.");
    const frame = flag(args.values.frame);
    const result = await continueShot({
      video: resolve(video),
      prompt: flag(args.values.prompt),
      mode: mode as ContinueMode,
      assets: args.values.asset ?? [],
      aspectRatio: aspect as "16:9" | "9:16" | undefined,
      model: flag(args.values.model),
      duration: flag(args.values.duration),
      wait: Boolean(args.values.wait),
      waitTimeout: flag(args.values["wait-timeout"]),
      frame: frame ? resolve(frame) : undefined,
      run: Boolean(args.values.run),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.ran && result.exit_code) process.exit(result.exit_code);
    return;
  }

  throw new Error(`Unknown command "${command}". Run flow-movie --help.`);
}

main().catch(fail);
