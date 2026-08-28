#!/usr/bin/env python3
"""Measures a rendered track (tempo, beats, structural segments, onsets) and writes JSON to stdout.

Usage: python analyze.py <audio-file> [--segments N]

The output shape matches src/timeline/__tests__/fixtures/bgm-analysis.json, which snap.ts
treats as ground truth for what this script must produce.
"""

import argparse
import json
import sys

import librosa
import numpy as np

DEFAULT_SEGMENTS = 6


def analyze(audio_path: str, segment_count: int) -> dict:
    y, sr = librosa.load(audio_path, sr=None, mono=True)
    duration_sec = float(librosa.get_duration(y=y, sr=sr))

    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    tempo, beat_times = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, units="time")
    onset_times = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr, units="time")

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    k = max(1, min(segment_count, chroma.shape[1]))
    bound_frames = librosa.segment.agglomerative(chroma, k)
    bound_times = librosa.frames_to_time(bound_frames, sr=sr)
    segment_times = sorted(set([0.0] + [round(float(t), 4) for t in bound_times]))

    return {
        "durationSec": round(duration_sec, 4),
        "tempo": round(float(np.asarray(tempo).item()), 4),
        "beats": [round(float(t), 4) for t in beat_times],
        "segments": segment_times,
        "onsets": [round(float(t), 4) for t in onset_times],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze an audio file's tempo, beats, segments, and onsets.")
    parser.add_argument("audio_file", help="Path to the audio file to analyze.")
    parser.add_argument("--segments", type=int, default=DEFAULT_SEGMENTS, help="Number of structural segments.")
    args = parser.parse_args()

    try:
        result = analyze(args.audio_file, args.segments)
    except Exception as err:  # noqa: BLE001 - surface any analysis failure as a clean error
        print(f"analyze.py: failed to analyze {args.audio_file!r}: {err}", file=sys.stderr)
        return 1

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
