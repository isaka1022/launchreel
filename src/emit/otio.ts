import { estimateSpeechSeconds } from '../speech-rate.js';
import { shotSpans, totalDurationSec, type Reel, type Shot } from '../timeline/schema.js';

/**
 * Builds an OpenTimelineIO document from a Reel. Pure — media paths are resolved by the
 * caller and passed in. Schema strings and frame math live here rather than in the model's
 * output, because a single malformed `RationalTime` makes the whole file unreadable.
 *
 * Verified against a reference document produced by opentimelineio 0.18.1: clips use the
 * `Clip.2` shape with a `media_references` map, not the older singular `media_reference`.
 */

export interface MediaResolution {
  /** Absolute path to the rendered media for a shot, when one exists yet. */
  shotMedia: Map<string, string>;
  /** Absolute path to each narration line's synthesized wav. */
  narrationMedia: Map<string, string>;
  /** Absolute path to the selected music track. */
  musicMedia?: string;
  /** Tracks laid end to end, when the reel is long enough to need more than one. Wins over `musicMedia`. */
  musicSegments?: MusicSegmentMedia[];
}

export interface MusicSegmentMedia {
  path: string;
  startSec: number;
  durationSec: number;
}

/** Provenance recorded on every generated clip, so a re-edit knows how it was made. */
export interface ClipProvenance {
  model?: string;
  prompt?: string;
  seed?: number;
  costUsd?: number;
  generatedAt?: string;
}

interface RationalTime {
  OTIO_SCHEMA: 'RationalTime.1';
  rate: number;
  value: number;
}

interface TimeRange {
  OTIO_SCHEMA: 'TimeRange.1';
  start_time: RationalTime;
  duration: RationalTime;
}

function time(seconds: number, fps: number): RationalTime {
  return { OTIO_SCHEMA: 'RationalTime.1', rate: fps, value: Math.round(seconds * fps) };
}

function range(startSec: number, durationSec: number, fps: number): TimeRange {
  return {
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: time(startSec, fps),
    duration: time(durationSec, fps),
  };
}

function externalRef(targetUrl: string, durationSec: number, fps: number): unknown {
  return {
    OTIO_SCHEMA: 'ExternalReference.1',
    name: '',
    available_range: range(0, durationSec, fps),
    available_image_bounds: null,
    target_url: targetUrl.startsWith('file://') ? targetUrl : `file://${targetUrl}`,
  };
}

function clip(
  name: string,
  durationSec: number,
  fps: number,
  mediaPath: string | undefined,
  metadata: Record<string, unknown>,
): unknown {
  const base = {
    OTIO_SCHEMA: 'Clip.2',
    name,
    source_range: range(0, durationSec, fps),
    enabled: true,
    color: null,
    metadata,
    active_media_reference_key: 'DEFAULT_MEDIA',
  };
  return {
    ...base,
    media_references: {
      DEFAULT_MEDIA: mediaPath
        ? externalRef(mediaPath, durationSec, fps)
        : { OTIO_SCHEMA: 'MissingReference.1', name: '', available_range: null, available_image_bounds: null, metadata: {} },
    },
  };
}

function gap(durationSec: number, fps: number): unknown {
  return {
    OTIO_SCHEMA: 'Gap.1',
    name: '',
    source_range: range(0, durationSec, fps),
    enabled: true,
    color: null,
    metadata: {},
  };
}

function marker(name: string, atSec: number, fps: number, color: string): unknown {
  return {
    OTIO_SCHEMA: 'Marker.2',
    name,
    color,
    marked_range: range(atSec, 0, fps),
    comment: '',
    metadata: {},
  };
}

function track(name: string, kind: 'Video' | 'Audio', children: unknown[], markers: unknown[] = []): unknown {
  return {
    OTIO_SCHEMA: 'Track.1',
    name,
    kind,
    source_range: null,
    enabled: true,
    color: null,
    children,
    markers,
    effects: [],
    metadata: {},
  };
}

function shotMetadata(shot: Shot, provenance: ClipProvenance | undefined): Record<string, unknown> {
  const launchreel: Record<string, unknown> = { kind: shot.kind, label: shot.label };
  if (shot.evidenceRange) launchreel.evidenceRange = shot.evidenceRange;
  if (shot.prompt) launchreel.prompt = shot.prompt;
  if (provenance) Object.assign(launchreel, provenance);
  return { launchreel };
}

export interface BuildOtioOptions {
  media?: Partial<MediaResolution>;
  provenance?: Map<string, ClipProvenance>;
  /** Narration start times, when `fit.ts` has resolved them. Keyed by narration line id. */
  narrationAt?: Map<string, number>;
  /** Measured duration of each narration wav, keyed by line id. */
  narrationDuration?: Map<string, number>;
}

export function buildOtio(reel: Reel, options: BuildOtioOptions = {}): unknown {
  const fps = reel.fps;
  const spans = shotSpans(reel);
  const spanById = new Map(spans.map((s) => [s.shotId, s]));
  const shotMedia = options.media?.shotMedia ?? new Map<string, string>();
  const narrationMedia = options.media?.narrationMedia ?? new Map<string, string>();

  const videoChildren = reel.shots.map((shot) =>
    clip(shot.id, shot.durationSec, fps, shotMedia.get(shot.id), shotMetadata(shot, options.provenance?.get(shot.id))),
  );

  const hitMarkers = reel.hitPoints.map((at, i) => marker(`hit_${i + 1}`, at, fps, 'RED'));

  const tracks: unknown[] = [track('V1', 'Video', videoChildren, hitMarkers)];

  if (reel.narration.length > 0) {
    const lines = [...reel.narration].sort((a, b) => resolveAt(a.id, a.shotId) - resolveAt(b.id, b.shotId));
    const narrationChildren: unknown[] = [];
    let cursor = 0;
    for (const line of lines) {
      const at = resolveAt(line.id, line.shotId);
      const duration = options.narrationDuration?.get(line.id) ?? estimateSpeechSeconds(line.text);
      if (at > cursor) {
        narrationChildren.push(gap(at - cursor, fps));
        cursor = at;
      }
      narrationChildren.push(
        clip(line.id, duration, fps, narrationMedia.get(line.id), {
          launchreel: { kind: 'narration', text: line.text, shotId: line.shotId },
        }),
      );
      cursor += duration;
    }
    tracks.push(track('A1_VO', 'Audio', narrationChildren));
  }

  const total = totalDurationSec(reel);
  if (reel.music) {
    const musicMeta = { kind: 'music', caption: reel.music.caption, structureTags: reel.music.structureTags };
    const segments = options.media?.musicSegments;
    if (segments !== undefined && segments.length > 0) {
      const children: unknown[] = [];
      let cursor = 0;
      segments.forEach((segment, i) => {
        if (segment.startSec > cursor) {
          children.push(gap(segment.startSec - cursor, fps));
          cursor = segment.startSec;
        }
        children.push(clip(`music_${i + 1}`, segment.durationSec, fps, segment.path, { launchreel: musicMeta }));
        cursor += segment.durationSec;
      });
      tracks.push(track('A2_MUSIC', 'Audio', children));
    } else {
      const musicDuration = Math.min(reel.music.targetDurationSec, total);
      tracks.push(track('A2_MUSIC', 'Audio', [clip('music', musicDuration, fps, options.media?.musicMedia, { launchreel: musicMeta })]));
    }
  }

  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: reel.title,
    global_start_time: time(0, fps),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      source_range: null,
      enabled: true,
      color: null,
      children: tracks,
      markers: [],
      effects: [],
      metadata: {},
    },
    metadata: {
      launchreel: {
        version: reel.version,
        generator: 'launchreel',
        totalDurationSec: total,
        hitPoints: reel.hitPoints,
      },
    },
  };

  function resolveAt(lineId: string, shotId: string): number {
    const explicit = options.narrationAt?.get(lineId);
    if (explicit !== undefined) return explicit;
    const line = reel.narration.find((l) => l.id === lineId);
    if (line?.atSec !== undefined) return line.atSec;
    return spanById.get(shotId)?.start ?? 0;
  }
}

export function otioToJson(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
