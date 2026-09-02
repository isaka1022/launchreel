import { describe, expect, it } from 'vitest';
import { buildCaptionSvg } from '../caption.js';

describe('buildCaptionSvg', () => {
  it('枠内に収まる文字数で折り返し、プレートを画面下部に中央寄せで置く', () => {
    const svg = buildCaptionSvg('It opens in a real editor. Every clip its own. Narration and music on separate tracks.', {
      width: 1920,
      height: 1080,
    });

    const tspans = [...svg.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]!);
    expect(tspans.length).toBe(2);
    expect(tspans.join(' ')).toBe('It opens in a real editor. Every clip its own. Narration and music on separate tracks.');

    const box = /<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/.exec(svg);
    expect(box).not.toBeNull();
    const [x, y, w, h] = box!.slice(1).map(Number) as [number, number, number, number];
    expect(x + w).toBeLessThanOrEqual(1920);
    expect(Math.abs(x - (1920 - (x + w)))).toBeLessThanOrEqual(1); // odd widths round a pixel off centre
    expect(y + h).toBeLessThan(1080);
    expect(svg).toContain('text-anchor="middle"');
  });
});
