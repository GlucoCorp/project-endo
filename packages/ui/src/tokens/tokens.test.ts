import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MINIMUM_CONTRAST, contrastRatio, relativeLuminance } from './contrast.ts';
import {
  COLOUR_NAMES,
  COLOUR_PAIRS,
  DARK,
  DECORATIVE,
  LIGHT,
  MORE_CONTRAST,
  RADIUS,
  SPACE,
  TYPE,
  tokensCss,
  type Palette,
} from './tokens.ts';

const MODES: [string, Palette][] = [
  ['light', LIGHT],
  ['dark', DARK],
  ['light, more contrast', { ...LIGHT, ...MORE_CONTRAST.light }],
  ['dark, more contrast', { ...DARK, ...MORE_CONTRAST.dark }],
];

describe('spec 21.4 contrast: the WCAG 2.2 formula', () => {
  it('matches the reference values', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBe(1);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 10);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBe(1);
    // Order does not matter.
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(
      contrastRatio('#FFFFFF', '#767676'),
      10,
    );
    // #767676 on white is the well-known smallest grey that passes AA (4.54:1).
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
  });

  it('refuses anything but #RRGGBB', () => {
    for (const bad of ['#FFF', 'white', '#GGGGGG', 'rgb(0,0,0)'])
      expect(() => relativeLuminance(bad)).toThrow(TypeError);
  });
});

describe('spec 21.4 and 21.10: every colour pairing meets WCAG 2.2 in every mode', () => {
  it.each(MODES)('%s', (_, palette) => {
    const failures = COLOUR_PAIRS.flatMap((p) => {
      const ratio = contrastRatio(palette[p.fg], palette[p.bg]);
      return ratio >= MINIMUM_CONTRAST[p.use]
        ? []
        : [
            `${p.fg} on ${p.bg} (${p.where}): ${ratio.toFixed(2)} < ${String(MINIMUM_CONTRAST[p.use])}`,
          ];
    });
    expect(failures).toEqual([]);
  });

  it('with more contrast, secondary text reaches AAA', () => {
    for (const [mode, base] of [
      ['light', LIGHT],
      ['dark', DARK],
    ] as const) {
      const p = { ...base, ...MORE_CONTRAST[mode] };
      for (const bg of ['surface', 'surface-raised'] as const)
        expect(contrastRatio(p['ink-muted'], p[bg])).toBeGreaterThanOrEqual(7);
    }
  });

  it('keeps decorative colours out of text and control boundaries', () => {
    for (const p of COLOUR_PAIRS) expect(DECORATIVE).not.toContain(p.fg);
  });

  it('reserves critical for red flags only', () => {
    const uses = COLOUR_PAIRS.filter((p) => p.fg === 'critical' || p.bg === 'critical');
    expect(uses.length).toBeGreaterThan(0);
    for (const p of uses) expect(p.where).toMatch(/red-flag/);
  });

  it('keeps the four Trial Strip lanes apart from each other and from critical', () => {
    // Words and shapes carry the meaning (spec 21.2); colour must still not collide.
    for (const palette of [LIGHT, DARK]) {
      const lanes = [
        palette['lane-benefit'],
        palette['lane-side-effects'],
        palette['lane-taken'],
        palette['lane-barriers'],
        palette.critical,
      ];
      expect(new Set(lanes).size).toBe(lanes.length);
    }
  });
});

describe('spec 21.3 and 21.5: type, space and shape', () => {
  it('uses the specified scales and nothing else', () => {
    expect(Object.values(TYPE.scale)).toEqual([0.8125, 0.875, 1, 1.125, 1.375, 1.75, 2.25]);
    expect(SPACE).toEqual([4, 8, 12, 16, 24, 32, 48, 64]);
    expect(SPACE.every((s) => s % 4 === 0)).toBe(true);
    expect(RADIUS).toEqual({ control: 4, sheet: 12 });
  });

  it('defines every colour in both modes', () => {
    for (const name of COLOUR_NAMES) {
      expect(LIGHT[name]).toMatch(/^#[0-9A-F]{6}$/);
      expect(DARK[name]).toMatch(/^#[0-9A-F]{6}$/);
    }
  });
});

describe('tokens.css', () => {
  const css = tokensCss();

  it('is the committed file, regenerated from the tokens (pnpm --filter @endo/ui tokens:css)', () => {
    const committed = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');
    expect(committed).toBe(css);
  });

  it('carries dark mode, more contrast and reduced motion', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('@media (prefers-contrast: more)');
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{\s*--motion-state: 0ms linear;\s*--motion-sheet: 0ms linear;/,
    );
    for (const name of COLOUR_NAMES)
      expect(css).toContain(`--${name}: ${LIGHT[name].toLowerCase()};`);
  });

  it('holds no gradients or shadows (spec 21.4, 21.5)', () => {
    expect(css).not.toMatch(/gradient|shadow/i);
  });
});
