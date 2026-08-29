# LaunchReel

You shipped something. Now you need a video about it, and that costs you a day you would
rather spend building.

## The problem

Every demo-video tool on the market records your clicks and stitches them together. None of
them understand what happened. They hand you a flat mp4 you cannot edit, with stock music
chosen from a dropdown, and cuts that land wherever the recording happened to pause.

Developers already produce a perfect record of what their software does: a terminal session.
Nothing turns it into something you would put at the top of a README.

## What LaunchReel does

Point it at a recording you already know how to make — `asciinema` or `vhs` — and it reads the
session, works out what was actually demonstrated, and builds the video around that.

MiniMax M3 reads the evidence and designs the timeline: which moments matter, how long each
one should hold, what the narration says, where the cuts fall.

## The part that is genuinely hard

Generated music cannot be told to put an accent at fourteen seconds. MiniMax Music 3.0 has no
editing, no continuation, no seed, and it ignores tempo requests entirely. Asking it to hit
your marks does not work.

So LaunchReel does the opposite. It generates several candidates that differ in when the pulse
arrives, measures every one of them with librosa, and moves the cuts onto the beats it actually
finds. The first version asked for a single brief and got a track whose first beat landed at
eleven seconds — no amount of snapping saves a cut at four seconds in a track like that.
Measuring is what exposed it.

Narration works the same way. Speech 2.8 returns audio of a length nobody can predict from the
text, so every line is synthesized and measured before the timeline is fixed. When a line
overruns, the shot stretches; when it cannot, the line goes back to M3 with a character budget.

## What you get

Two things, not one. `reel.mp4`, and `reel.otio` — the timeline itself, which opens in a real
editor with every shot as its own clip, narration and music on separate tracks, and the cut
points marked where the beats are. Every clip carries the model and prompt that made it.

No other tool in this space gives you the project file. You get an mp4 and a shrug.

## Try it

It ships with a recorded session and everything it generated, so the first run needs no API
key, no network, and no Python.

    npx launchreel build examples/self --offline

Free and open source. MIT.
