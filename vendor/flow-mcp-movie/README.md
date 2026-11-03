# flow-mcp movie port

Local music, narration, captions, and last-frame continuation for Flow Connector.
The implementations under `src/` that carry a flow-mcp header are copied from
[flow-mcp](https://github.com/GTAI-1/flow-mcp). Upstream `package.json` says
`"license": "ISC"`. The author field is empty and the archive has no LICENSE
file. The permission notice is in [NOTICE](NOTICE). Do not remove it.

This folder does not relicense Flow Connector.
Attribution: MaxOut AI.
This copy and this skill cannot be replicated under the MIT license.

## What runs here

These commands do not open Google Flow and do not spend Flow credits, except
`continue --run`, which calls an already installed `flow-auto` and therefore
can spend credits. **`--run` is off by default.**

Build once in this folder (`dist/` is not committed):

```bash
npm install
npm run build
```

Then, from the Flow Connector checkout, run `bin/flow-movie`. That wrapper
executes `dist/cli.js`. This package's npm bin is the same name, `flow-movie`.
You do not need to `cd` here or remember `node dist/cli.js`.

```bash
bin/flow-movie --help
```

Every flag below is also in that help text, with the same default.

### `narrate`

| Flag | Default |
|---|---|
| `--text` | required |
| `--engine` | `gemini` (`gemini` or `mac`) |
| `--voice` | `Charon` for Gemini. Required for `--engine mac`. |
| `--style` | none. Gemini only. Sent as `Say <style>: <text>`. |
| `--model` | `gemini-2.5-flash-preview-tts`, or `FLOW_MCP_GEMINI_TTS` if that is set and `--model` is omitted |
| `--rate` | `168` (macOS `say` words per minute, 50–400). Not used by Gemini. Windows has no rate control. |
| `--out` | `./narration.m4a` |

`--engine mac` uses a voice installed on this computer. `--engine gemini` uses
Google AI Studio TTS. A key is read from `GEMINI_API_KEY` or
`~/.flow-mcp/gemini-key`. This command will not ask for or store a key.
`voices` lists the Gemini voice names and this computer's English voices. It
does not print a key.

### `assemble`

Joins clips into one MP4. `--clip-volume` is the clips' own sound. `--music`
is the music path, looped under the film at `--music-volume`. `--voiceover`
is the voiceover path, mixed at `--voice-volume`. `--voice-lines` builds that
track first from a JSON array of `{file, at, from?, to?, max_seconds?}`.

| Flag | Default |
|---|---|
| `--dir` | required. Folder the film is written into. |
| `--clip` | repeatable. Numbered `scene-` / `clip-` / `edit-` mp4s in `--dir`, else other mp4s oldest first. |
| `--music` | none |
| `--music-volume` | `0.25` (0–1) |
| `--clip-volume` | `1` (0–1) |
| `--voiceover` | none |
| `--voice-volume` | `1` (0–1). `--voice-lines` replaces `--voiceover` when both are set. |
| `--voice-lines` | none |
| `--output` | `final` → `<dir>/final.mp4` |
| `--hold-pad` | `0.6` seconds after the voiceover when the last frame is held (0–120) |
| `--no-hold` | off. Hold stays on when a voiceover is longer than the clips. |

```bash
bin/flow-movie assemble --dir ./film --clip a.mp4 --clip b.mp4 --music bed.mp3 --music-volume 0.25 --clip-volume 0.4 --voiceover narration.m4a --output final
```

### `transcribe` and `captions`

`transcribe <video>` returns words with start and end times via whisper.cpp
(`whisper-cli` on `PATH`, or `FLOW_MCP_WHISPER`). `--language` defaults to
`auto`. `--no-words` prints the transcript only; the default includes timings.

`captions <video>` burns those words in and writes a sibling `.srt`. Needs
Chrome and ffmpeg. The first run can download a speech model (about 148 MB
for English, about 574 MB otherwise). `caption-setup` takes no flags.

| Flag | Default |
|---|---|
| `--style` | `bold` (`bold`, `highlight`, `reveal`, `clean`, `boxed`) |
| `--position` | `bottom` (`bottom`, `middle`, `top`, or 0–100) |
| `--size` | `medium` (`small`, `medium`, `large`, or 40–250 where 100 = medium) |
| `--language` | `auto` |
| `--text` | what whisper heard |
| `--letters` | bold uses `capitals`; every other style uses `as_said` |
| `--name` | none. Repeatable. Keeps that word's capitals when `--letters lowercase`. |
| `--color` | bold `#FFE135`, highlight `#7C3AED`, reveal / clean / boxed `#FFFFFF` |
| `--lead` | `0.12` seconds (−0.5 to 0.5) |
| `--out` | `<video-dir>/<stem>-captions.mp4` |

```bash
bin/flow-movie captions scene.mp4 --style bold --language en --position bottom --size medium --out scene-captions.mp4
```

### `continue <clip>`

Saves the last frame with ffmpeg. That is the local half of continuing a shot.
`--frame` chooses the jpeg. The default path is `<clip>-lastframe.jpg`.

`continue` prints a `flow-auto` command when you pass `--prompt`. It does not
run it unless you also pass `--run`. **`--run` defaults to off.**

| Flag | Default |
|---|---|
| `--prompt` | none. With no prompt, only the frame is saved. |
| `--mode` | `exact` (`exact` or `likeness`) |
| `--asset` | none. Repeatable character name. Likeness only. |
| `--aspect-ratio` | omitted (`16:9` or `9:16`, forwarded) |
| `--model` | omitted. This is the flow-auto video model, not the narrate TTS model. |
| `--duration` | omitted |
| `--wait` | off |
| `--wait-timeout` | omitted (flow-auto's own default is 15 minutes) |
| `--frame` | `<clip>-lastframe.jpg` |
| `--run` | **off** |

- `--mode exact` (the default) maps to `flow-auto generate create flow-frame-to-video --image <lastframe>`. The next clip is meant to open on that frame. Do not pass `--asset`: Flow's frame composer drops characters.
- `--mode likeness --asset "NAME"` maps to `flow-auto generate create flow-ingredients-to-video --image <lastframe> --asset "NAME"`. The character stays attached. The opening frame is only approximate.

```bash
bin/flow-movie continue scene.mp4 --prompt "she looks back" --mode likeness --asset "NARRATOR"
```

`flow-extend-video` is a different Flow Connector command. It lengthens the
Veo clip already open in the editor. `continue` does not call it. Add `--run`
only when that generation should spend Flow credits. The binary is `flow-auto`,
or whatever `FLOW_AUTO` names.

## What is not wired

The Flow Connector Chrome extension source is not in this repository (the
extension is the store build; this checkout has the README, the skill, assets,
and the `flow-auto` CLI tarball). Because of that, this port does not drive
the open Flow tab itself.

Not ported, on purpose:

- flow-mcp's Flow Studio panel
- its separate Chrome profile and Google sign-in
- `runContinue` in its `flow.ts`, which clicks Flow's grid, Save frame, Animate, and the agent character chips inside that profile

Character attachment for a continuation is the `--asset` flag on the existing
`flow-auto` ingredients command, and only in `--mode likeness`. There is no
second path that attaches a character inside an exact first-frame generation.
Flow's own limit, as flow-mcp documents it, is that those two cannot be done
together.

ffmpeg is required for assemble, narrate, and continue (`brew install ffmpeg`
on a Mac). Captions also need `whisper-cli`.
