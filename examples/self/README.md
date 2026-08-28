# examples/self

LaunchReel making a launch video about itself — `demo.cast` is a recording of the CLI's own
`plan` → `narrate` → `score` → `build` chain.

```bash
launchreel build examples/self --offline -o out
```

`--offline` replays the cached model output in `.cache/` (M3's plan, narration audio, and music
candidates) instead of calling GMI Cloud, so this needs no API key and no network.

Narration was synthesized with `--provider system` (macOS `say`), not MiniMax Speech 2.8 HD —
Speech 2.8 was returning 503 (capacity exhausted) during MiniMax Week when this example was built.

`.cache/music/` holds three copies of one real Music 3.0 track (mp3, downsampled from the
original wav to stay small) rather than three distinct candidates, since only one track was
generated before 503s made further candidates impractical to fetch.
