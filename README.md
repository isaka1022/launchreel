# LaunchReel

**Turn a terminal recording into a launch video whose cuts land on the beat.**

You shipped something. Now you need a video about it. LaunchReel reads a recording you already
know how to make (`asciinema` or `vhs`), works out what actually happened in it, and builds the
video around that — narration, a generated soundtrack, title cards, cuts.

The part that makes it different is what happens to the audio. MiniMax Music 3.0 cannot be told
"put an accent at 0:14." It has no editing, no continuation, no seed, and it ignores tempo
requests. So LaunchReel doesn't ask the model to hit marks. **It generates candidates, measures
them, and moves the cuts to the beats it actually finds.**

```bash
git clone https://github.com/isaka1022/launchreel && cd launchreel
npm install
npx tsx src/cli.ts build examples/self --offline
```

No API key, no network, no Python. That command replays committed fixtures and writes
`reel.mp4`, `reel.otio` and `reel.report.json` — the same output the numbers below came from.

---

## The soundtrack is measured, not requested

Ask Music 3.0 for a 30-second track at 120 BPM and you get 60 seconds at 83.35 BPM. Complaining
about that is not a strategy. Measuring it is.

Each candidate varies the one dimension that actually moves the beat grid — when the pulse
arrives and how dense it is — and every candidate is analysed with librosa before anything is
committed to:

```
score: 3 candidates
  track 1   5/5 hits   shift 0.546s   129.2 BPM   <- selected
  track 2   5/5 hits   shift 0.569s   129.2 BPM
  track 3   5/5 hits   shift 0.706s   112.3 BPM

  4.498s → beat 4.632   (+0.135)  cut moved onto the beat
 12.431s → beat 12.481  (+0.049)  already on the beat
 18.873s → beat 18.959  (+0.086)  already on the beat
 22.394s → beat 22.198  (-0.196)  cut moved onto the beat
 26.435s → beat 26.355  (-0.080)  already on the beat
```

Two cuts were moved. Three were already inside the 120 ms tolerance, so the timeline was left
alone — moving a cut that is already on the beat only costs you elsewhere. When a cut does move,
the neighbouring shot absorbs exactly the opposite shift, so **the total duration never changes.**

### Why there are candidates at all

The first version sent the same request three times, which is the same as not having candidates.
Measurement is what exposed it:

| | tempo | first beat | hit points landed |
|---|---|---|---|
| single brief | 83.35 BPM | **11.064s** | 4 of 5 |
| candidates varied | 129.2 BPM | **0.476s** | 5 of 5 |

That track opened with eleven seconds of pads. No amount of snapping can put a beat at 4.5
seconds in a track whose first beat is at 11. The fix wasn't better snapping — it was asking for
a different piece of music and having a way to tell which one was better.

---

## The narration sets the timing, not the other way round

Speech 2.8 returns audio of a length you cannot predict from the text. So the reel is not built
and then narrated. **Every line is synthesized and measured first**, and the timeline is refit
around what actually came back, through four rungs in order:

1. **stretch the shot** to the measured speech
2. **hand the line back to M3** with a character budget and re-synthesize just that line
3. **`atempo`** up to 1.06 — beyond that it stops sounding like a person
4. **hold the last frame**

Rung 2 is a model call, so `--offline` skips it and says so rather than pretending. Nothing here
truncates a line silently; if a line still doesn't fit after all four, the report says so.

`reel.report.json` records how each line was closed, so an overrun is never invisible:

```json
"narrate": { "lines": 7, "speechSec": 27.309, "tiers": { "extended": 5, "fits": 2 } }
```

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
   ├── Speech 2.8    →  narration, measured, then the timeline is refit around it
   ├── Music 3.0     →  candidates, scored on how many cuts can land on a beat
   └── agg + ffmpeg  →  each shot rendered to the exact second
   │
   ▼
reel.mp4  +  reel.otio  +  reel.report.json
```

M3 is never asked to emit OpenTimelineIO. It emits a small intermediate representation, and
LaunchReel turns that into a valid timeline deterministically — one malformed `RationalTime`
makes the whole project file unreadable, and that is not a thing to leave to a language model.
When its output doesn't validate, the failure is handed back verbatim and it tries again.

`.cast` is the primary input for a reason: M3's temporal grounding on long video is poor, and a
terminal recording already carries the timestamps in the data. The model's weakness is avoided
by the choice of input format rather than worked around downstream.

---

## The timeline comes out too

`reel.otio` is [OpenTimelineIO](https://opentimelineio.readthedocs.io/) — JSON. The reference
implementation reads it (`otiotool --stats`), and `otioconvert` turns it into FCPXML 1.8, which
is what gets it into an NLE. `npm run gate` checks the round trip; opening the result in Resolve
or Premiere is not something this repo can verify for you.

Every shot arrives as its own clip, narration and music on separate tracks, and **the snapped
cut points as markers** — so the alignment above isn't a claim in a README, it's something you
can open a timeline and look at.

Each clip carries its provenance:

```json
"launchreel": {
  "kind": "terminal",
  "label": "Running the build",
  "evidenceRange": [8.0, 12.5]
}
```

---

## Commands

```bash
launchreel ingest  <file.cast|file.tape>     # → evidence
launchreel plan    <recording>               # → timeline design (MiniMax M3)
launchreel narrate <reel.json>               # → speech, then refit around measured durations
launchreel score   <reel.json>               # → music candidates, measured, cuts snapped
launchreel emit    <reel.json> --otio        # → OpenTimelineIO
launchreel build   <recording>               # → all of the above, plus the mp4
```

Each step writes a file you can inspect and edit by hand before running the next one.

| Flag | What it does |
|---|---|
| `--offline` | Replay committed fixtures. No key, no network, no cost |
| `--provider system` | Use the OS voice instead of Speech 2.8, for local iteration |
| `--lang ja` | Japanese narration |
| `--duration <sec>` | Target length, default 30 |
| `--skip-music` | Build without a soundtrack |

`--offline` fails loudly on a cache miss rather than quietly substituting something else. A
replay that silently produces a different video isn't a replay.

---

## Setup

Building your own recording needs a little more than the offline demo:

```bash
brew install ffmpeg agg librsvg     # render terminals and title cards
npm install
python3 -m venv .venv && ./.venv/bin/pip install -r py/requirements.txt   # librosa, for new music
```

Then set a GMI Cloud key — every model used here is free during MiniMax Week:

```bash
export GMI_API_KEY=...           # or put it in ~/.secrets/gmi/.env
```

LaunchReel reads `GMI_API_KEY` from the environment first, then `~/.secrets/gmi/.env`. It never
prints the value.

---

## The models, and what each one is pushed on

| Model | Used for | What it can't do, and how that's handled |
|---|---|---|
| **Music 3.0** | Soundtrack | No seed, no editing, no continuation, ignores tempo. Candidates are varied on pulse onset and density, then measured; cuts move to the beats |
| **Speech 2.8** | Narration | Output length is unpredictable. Measured first, then the timeline is refit around the real durations through four rungs |
| **MiniMax M3** | Reads the evidence, designs the timeline | Won't reliably emit valid OTIO. Constrained to a small IR via a forced tool call, with schema failures fed back |

---

## Limits, stated plainly

- **No video generation.** A developer launch video is carried by the thing actually running.
  Generated B-roll is where these videos start to look like every other AI video.
- **The recording has to be long enough.** Feed it 4 seconds and ask for 30 and you get held
  frames. LaunchReel warns when a shot is more than half freeze.
- **Speech 2.8 has been returning 503 during MiniMax Week.** Retries with backoff are built in,
  and the committed example was narrated with the macOS voice for that reason.
- **Only tested on macOS.** The `say` fallback is macOS-only; everything else should port.

---

## License

MIT
