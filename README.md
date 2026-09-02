# LaunchReel

**Turn terminal recordings into a product video whose cuts land on the beat — and get the
editable timeline, not just an mp4.**

You shipped something. Now you need a video about it, and that costs you a day you would rather
spend building. LaunchReel reads recordings you already know how to make (`asciinema` or `vhs`),
works out what was actually demonstrated, and builds the video around it — narration, a generated
soundtrack, title cards, cuts.

```bash
git clone https://github.com/isaka1022/launchreel && cd launchreel
npm install && npm run build

npx launchreel build examples/pitch --offline    # 88.87s product video from a pitch + 5 recordings
npx launchreel build examples/self  --offline    # 41.0s reel from a single recording
```

No API key, no network, no Python. Both replay committed fixtures and write `reel.mp4`,
`reel.srt`, `reel.otio` and `reel.report.json` — the same files the numbers below came from.

---

## The soundtrack is measured, not requested

MiniMax Music 3.0 cannot be told to put an accent at 0:14. It has no seed, no editing, no
continuation, and it ignores tempo requests — ask for 120 BPM and you get 83.35. Ask twice with
the same brief and you get two different tracks, of two different lengths.

So LaunchReel never asks the model to hit a mark. It generates candidates, measures every one
with librosa, and moves the cuts onto the beats it actually finds:

```
score: 3 candidates for 0.0-92.63s
  track 1   145.18s   covers           136.0 BPM   16/23 hits
  track 2   147.54s   covers           129.2 BPM   23/23 hits   <- selected
  track 3    35.32s   does not cover    97.5 BPM   10/23 hits
```

Track 3 was rejected before it was judged on fit at all: it stops before the segment does, and
cuts that land beautifully from a track that has already ended are worth nothing. Length is not a
request either — those three came from one brief and measured **145.18s, 147.54s and 35.32s**, so
coverage is measured rather than assumed from the prompt.

Tracks 1 and 2 both cover it, and that is where the measurement earns its keep: 16 of the reel's
23 cuts find a beat in one, and all 23 in the other. Every cut is scored, not the handful the
model thought to mark — which is what makes the gap between two candidates mean something.

When a cut does move, the neighbouring shot absorbs exactly the opposite shift, so **the total
duration never changes.** Cuts already inside the 120 ms tolerance are left alone — moving a cut
that is already on the beat only costs you elsewhere.

### Why there are candidates at all

The first version sent the same request three times, which is the same as having no candidates.
Measuring is what exposed it:

| | tempo | first beat |
|---|---|---|
| single brief | 83.35 BPM | **11.064s** |
| candidates varied on pulse onset | 129.2 BPM | **0.476s** |

That track opened with eleven seconds of pads. No amount of snapping puts a beat at four seconds
in a track whose first beat is at eleven. The fix was not better snapping — it was asking for a
different piece of music and having a way to tell which one was better. The analysis of that
first track is committed as a test fixture, so the eleven seconds are checkable.

---

## The narration sets the timing, not the other way round

Speech 2.8 returns audio of a length you cannot predict from the text. So the reel is not built
and then narrated: **every line is synthesized and measured first**, and the timeline is refit
around what came back, through four rungs in order.

1. **stretch the shot** to the measured speech
2. **hand the line back to M3** with a character budget and re-synthesize just that line
3. **`atempo`** up to 1.06 — past that it stops sounding like a person
4. **hold the last frame**

Rung 2 is a model call, so `--offline` skips it and says so rather than pretending. Nothing here
truncates a line silently. `reel.report.json` records how each line was closed:

```json
"narrate": { "lines": 17, "speechSec": 65.434, "tiers": { "fits": 8, "extended": 9 } }
```

Captions come out of the same measurement. Each line is burned into the picture, and written to
`reel.srt`, over the span the mixed audio actually occupies — so a caption cannot drift away from
the voice it belongs to the way one transcribed from a script would.

---

## Long-form: a pitch and several recordings

Point `build` at a directory holding `pitch.md` and `footage/` and it makes a product video
instead of a reel. M3 reads the pitch as the argument the video has to make, and reaches into
the recordings for the evidence behind each claim.

```bash
launchreel build examples/pitch                      # or --pitch <file> --footage <a.cast> ...
```

The honest constraint, which the build prints every run: **a terminal session is mostly still.**
In the measured 102.5s timeline, the screen actually changes for 25.744s — 25%. That is not a
flaw to engineer around — terminal output has to hold still long enough to read. What matters is
that every shot *opens* on the moment its screen starts drawing, so the viewer always arrives just
as something appears:

```
sources: setup 3.60s footage / 5.62s screen, build 19.14s / 16.06s,
         inspect 8.19s / 19.92s, timeline 8.28s / 18.18s
motion:  25.744s (25%) changes, 48.742s (48%) footage,
         42.728s (42%) cards, 11.031s (11%) held
```

M3 chooses where a shot opens. How much to play from there is arithmetic, so the range is grown
to cover the shot rather than left as the one-second sliver an onset occupies. Where footage
still runs short a shot may be slowed, but never below **0.6x** — under that a terminal reads as
frozen, and a held frame on finished output is honest where a crawl through an empty screen is
not.

The example targets 90 seconds because that is what its footage carries. Give it more recordings
and it will use them.

---

## What it actually does

```
footage/*.cast  +  pitch.md
   │
   │  ingest — strip ANSI, fold progress-bar redraws, detect prompts and pauses
   ▼
Evidence[]  { t, kind: command | output | pause, text }
   │
   │  MiniMax M3 reads the pitch and the evidence and designs a timeline
   │  (forced tool call; schema failures are fed straight back to the model)
   ▼
Reel IR   shots · narration · hit points · music brief
   │
   ├── Speech 2.8    →  narration, measured, then the timeline is refit around it
   ├── Music 3.0     →  candidates, scored on how many cuts can land on a beat
   └── agg + ffmpeg  →  each shot rendered to the exact second
   │
   ▼
reel.mp4  +  reel.srt  +  reel.otio  +  reel.report.json
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

Every shot arrives as its own clip, narration and music on separate tracks, and **the snapped cut
points as markers** — so the alignment above isn't a claim in a README, it's something you can
open a timeline and look at. Each clip carries its provenance:

```json
"launchreel": { "kind": "terminal", "label": "Running the build", "evidenceRange": [8.0, 12.5] }
```

---

## Commands

```bash
launchreel ingest  <file.cast|file.tape>     # → evidence
launchreel plan    <recording>               # → timeline design (MiniMax M3)
launchreel narrate <reel.json>               # → speech, then refit around measured durations
launchreel score   <reel.json>               # → music candidates, measured, cuts snapped
launchreel emit    <reel.json> --otio <out>   # → OpenTimelineIO
launchreel build   <recording|project dir>   # → all of the above, plus the mp4
launchreel prune   <recording|project dir>   # → drop cached assets the current plan no longer reads
```

Each step writes a file you can inspect and edit by hand before running the next one.

| Flag | What it does |
|---|---|
| `--offline` | Replay committed fixtures. No key, no network, no cost |
| `--provider system` | Use the OS voice instead of Speech 2.8, for local iteration |
| `--lang ja` | Japanese narration |
| `--duration <sec>` | Target length. 30 for a single recording, 90 for a long-form project |
| `--pitch` / `--footage` | Long-form inputs, when they aren't laid out as a project directory |
| `--skip-music` | Build without a soundtrack |
| `--dry-run` | `prune` only: list what would be deleted, delete nothing |

`--offline` fails loudly on a cache miss rather than quietly substituting something else. A
replay that silently produces a different video isn't a replay.

---

## Setup

Building from your own recordings needs a little more than the offline demo:

```bash
brew install ffmpeg agg librsvg     # render terminals and title cards
npm install && npm run build
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
| **Music 3.0** | Soundtrack | No seed, no editing, no continuation, ignores tempo, and returns a length of its own choosing. Candidates are varied on pulse onset and density, measured, filtered to those that cover their segment, then the cuts move to the beats |
| **Speech 2.8** | Narration | Output length is unpredictable. Measured first, then the timeline is refit around the real durations through four rungs |
| **MiniMax M3** | Reads the pitch and the evidence, designs the timeline | Won't reliably emit valid OTIO. Constrained to a small IR via a forced tool call, with schema failures fed back |

---

## Limits, stated plainly

- **No video generation.** A developer launch video is carried by the thing actually running.
  Generated B-roll is where these videos start to look like every other AI video.
- **A terminal session is mostly still.** About a fifth of one is the screen changing. LaunchReel
  reports the split every run rather than hiding it.
- **The narration overruns the character budget it is given.** M3 is told how many characters the
  target duration affords and can write past it anyway. The refit absorbs it; the measured mp4s
  come out at 88.87s and 41.0s. The report says which rung closed each line; nothing stops the
  model writing long.
- **Speech 2.8 returned 503 for stretches of MiniMax Week.** Retries with backoff are built in,
  and `--provider system` narrates with the macOS voice when it is down.
- **Only tested on macOS.** The `say` fallback is macOS-only; everything else should port.

---

## Generated audio

Everything under `examples/*/launchreel-cache/` is model output: the music from MiniMax Music
3.0, the narration from MiniMax Speech 2.8. The music files carry MiniMax's own AIGC identifier
in their metadata. Both are redistributed here under the terms the platforms grant for generated
content, which leave ownership of the output with whoever generated it.

---

## License

MIT — see [LICENSE](LICENSE).
