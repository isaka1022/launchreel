# LaunchReel

**Turn a terminal recording into a launch video — and get the timeline, not just the mp4.**

You shipped something. Now you need a video about it. LaunchReel reads a recording you already
know how to make (`asciinema` or `vhs`), works out what actually happened in it, and designs a
timeline around that — narration, a scored soundtrack, title cards, cuts.

It hands you two things:

- `reel.mp4` — the finished video
- `reel.otio` — **the timeline itself**, which opens in DaVinci Resolve, Premiere, or Final Cut

Every other tool in this space gives you a flat mp4 you can't touch. This one gives you the
project file, with every clip carrying the prompt and model that made it.

---

## Quickstart

```bash
npm install -g launchreel      # or: npx launchreel
launchreel build demo.cast
```

That's it. `demo.cast` is what `asciinema rec demo.cast` produces. A `.tape` file from
[vhs](https://github.com/charmbracelet/vhs) works too.

Want to see it work without an API key or a recording of your own?

```bash
git clone https://github.com/<user>/launchreel && cd launchreel
npm install && npm run build
launchreel build examples/self --offline
```

`--offline` replays cached model output, so it costs nothing and needs no key.

---

## What it actually does

```
demo.cast
   │
   │  ingest — strip ANSI, fold progress-bar redraws, detect prompts and pauses
   ▼
Evidence[]  { t, kind: command | output | pause, text }
   │
   │  MiniMax M3 reads the evidence and designs a timeline
   │  (forced tool call; schema failures are fed straight back to the model)
   ▼
Reel IR   shots · narration · hit points · music brief
   │
   ├── Speech 2.8 HD  →  narration, measured, then the timeline is refit around real durations
   ├── Music 3.0      →  3 candidate tracks, scored on how many hit points land on a beat
   └── agg + ffmpeg   →  each shot rendered to the exact second
   │
   ▼
reel.mp4  +  reel.otio
```

### The part that took the longest to get right

Music 3.0 can't be told "put an accent at 0:14." It has no editing, no continuation, and it
ignores tempo requests — we asked for 120 BPM and got 83.35. So LaunchReel doesn't ask the model
to hit marks. It **generates candidates, measures them with librosa, and moves the cuts to the
beats instead.**

```
hit points: [3, 8, 14, 17.5, 21]

   3s   → no beat within reach       ← this track's intro is 11s of pads
   8s   → no beat within reach
  14s   → beat 13.804s  (-0.196s)
  17.5s → beat 17.322s  (-0.178s)
  21s   → beat 20.933s  (-0.067s)

3/5 landed · total shift 0.441s · total duration unchanged
```

That's real output. It's also why there are three candidates: this track physically cannot serve
a hit point at 3 seconds, and only measuring tells you that.

---

## Commands

```bash
launchreel ingest  <file.cast|file.tape>     # → evidence
launchreel plan    <recording>               # → timeline design (MiniMax M3)
launchreel narrate <reel.json>               # → speech, then refit around measured durations
launchreel score   <reel.json>               # → music candidates, pick the best fit
launchreel emit    <reel.json> --otio        # → OpenTimelineIO
launchreel build   <recording>               # → all of the above, plus the mp4
```

Each step writes a file you can inspect and edit by hand before running the next one. Nothing is
hidden inside one opaque command.

### Useful flags

| Flag | What it does |
|---|---|
| `--offline` | Replay cached model output. No key, no network, no cost |
| `--provider system` | Use the OS voice instead of Speech 2.8, for fast local iteration |
| `--lang ja` | Japanese narration (15 Japanese voices are available) |
| `--duration <sec>` | Target length, default 30 |

---

## Setup

```bash
brew install ffmpeg agg          # rendering
npm install                      # the CLI
python3 -m venv .venv && ./.venv/bin/pip install -r py/requirements.txt   # librosa + OTIO
```

Set a GMI Cloud key — the models this uses are free during MiniMax Week:

```bash
export GMI_API_KEY=...           # or put it in ~/.secrets/gmi/.env
```

LaunchReel reads `GMI_API_KEY` from the environment first, then `~/.secrets/gmi/.env`. It never
prints the value.

---

## The models, and why each one

| Model | Used for | Cost |
|---|---|---|
| **MiniMax M3** | Reads the evidence and designs the timeline. 1M context, forced tool call | Free |
| **Speech 2.8 HD** | Narration. 332 voices, 15 of them Japanese | Free |
| **Music 3.0** | Soundtrack candidates, generated instrumental via `[Inst]` structure tags | Free |

M3 is not asked to emit OpenTimelineIO. It emits a small intermediate representation, and
LaunchReel turns that into a valid timeline deterministically — one malformed `RationalTime` makes
the whole project file unreadable, and that is not a thing to leave to a language model.

When the model returns something that doesn't validate, the failure is handed back to it verbatim
and it tries again (twice, by default). In practice it usually gets there in one.

---

## Editing what comes out

`reel.otio` is JSON. Drop it on a Resolve timeline and every shot arrives as its own clip, with
the narration and music on separate tracks and the hit points as markers.

Each clip carries its provenance in metadata:

```json
"launchreel": {
  "kind": "terminal",
  "label": "Running the build",
  "evidenceRange": [8.0, 12.5]
}
```

So a re-edit — or a re-render six months from now — knows where every frame came from.

---

## Limits, stated plainly

- **Video generation is not included.** MiniMax H3 exists and works, but a developer launch video
  is carried by the thing actually running. Generated B-roll is where these videos start to look
  like every other AI video. Cards and real footage instead.
- **The recording has to be long enough.** Feed it 4 seconds and ask for 30 and you get held
  frames. LaunchReel warns you when a shot is more than half freeze.
- **Speech 2.8 has been returning 503 during MiniMax Week.** Retries are built in with exponential
  backoff, and `--provider system` gets you moving locally in the meantime.
- **Only tested on macOS.** The `say` fallback is macOS-only; everything else should port.

---

## License

MIT
