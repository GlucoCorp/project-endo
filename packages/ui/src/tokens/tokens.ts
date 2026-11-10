import type { ContrastUse } from './contrast.ts';

/**
 * Design tokens (spec 21.3 to 21.5, 21.10): the only source of colour, type, space, shape and
 * motion for both apps. Components use the CSS custom properties generated from this file
 * (`tokens.css`), never literal values.
 */

export const COLOUR_NAMES = [
  'surface',
  'surface-raised',
  'ink',
  'ink-muted',
  'rule',
  'action',
  'on-action',
  'control-border',
  'focus-ring',
  'lane-benefit',
  'lane-side-effects',
  'lane-taken',
  'lane-barriers',
  'critical',
] as const;
export type ColourName = (typeof COLOUR_NAMES)[number];
export type Palette = Readonly<Record<ColourName, string>>;

/**
 * Spec 21.4, unchanged. Three tokens are added and say so:
 * - `on-action`: text on an `action` button (the spec names the button colour only);
 * - `control-border`: the boundary of inputs and controls. `rule` is decorative (about 1.3:1), so a
 *   control may never rely on it: WCAG 1.4.11 needs 3:1 for a control's boundary;
 * - `focus-ring`: the spec's focus colour, equal to `action`.
 */
export const LIGHT: Palette = {
  surface: '#F2F4F3',
  'surface-raised': '#FFFFFF',
  ink: '#1E2422',
  'ink-muted': '#56625E',
  rule: '#D3D9D6',
  action: '#0E5A52',
  'on-action': '#FFFFFF',
  'control-border': '#56625E',
  'focus-ring': '#0E5A52',
  'lane-benefit': '#2E6B4A',
  'lane-side-effects': '#8A5A08',
  'lane-taken': '#34508F',
  'lane-barriers': '#6A4F86',
  critical: '#A0102C',
};

export const DARK: Palette = {
  surface: '#151918',
  'surface-raised': '#1D2221',
  ink: '#E7ECEA',
  'ink-muted': '#A3AFAB',
  rule: '#2E3533',
  action: '#5FC2B5',
  'on-action': '#151918',
  'control-border': '#A3AFAB',
  'focus-ring': '#5FC2B5',
  'lane-benefit': '#6FC79A',
  'lane-side-effects': '#E3B04F',
  'lane-taken': '#8EA8E8',
  'lane-barriers': '#BBA2D8',
  critical: '#FF7A8F',
};

/**
 * `prefers-contrast: more` (spec 21.10): secondary text moves towards the primary ink and ruled
 * lines become visible boundaries. Only these change.
 */
export const MORE_CONTRAST: Readonly<Record<'light' | 'dark', Partial<Palette>>> = {
  light: { 'ink-muted': '#323B38', rule: '#56625E', 'control-border': '#1E2422' },
  dark: { 'ink-muted': '#D3DBD8', rule: '#A3AFAB', 'control-border': '#E7ECEA' },
};

/** A foreground on a background, how it is used, and why it exists. */
export interface ColourPair {
  readonly fg: ColourName;
  readonly bg: ColourName;
  readonly use: ContrastUse;
  readonly where: string;
}

const onSurfaces = (fg: ColourName, use: ContrastUse, where: string): ColourPair[] => [
  { fg, bg: 'surface', use, where },
  { fg, bg: 'surface-raised', use, where },
];

/**
 * Every colour pairing the apps may use. A pairing not listed here is not allowed; the contrast
 * test checks each one in every mode.
 */
export const COLOUR_PAIRS: readonly ColourPair[] = [
  ...onSurfaces('ink', 'text', 'body and UI text'),
  ...onSurfaces('ink', 'text-aaa', 'the verdict sentence and page titles (spec 21.4: AAA)'),
  ...onSurfaces('ink-muted', 'text', 'secondary text'),
  ...onSurfaces('action', 'text', 'links and text buttons'),
  ...onSurfaces('critical', 'text', 'red-flag text only'),
  { fg: 'on-action', bg: 'action', use: 'text', where: 'primary button label' },
  ...onSurfaces('control-border', 'non-text', 'input and control boundaries'),
  ...onSurfaces('focus-ring', 'non-text', 'keyboard focus ring'),
  ...onSurfaces('critical', 'non-text', 'the red-flag rule'),
  ...onSurfaces('lane-benefit', 'non-text', 'Trial Strip benefit marks'),
  ...onSurfaces('lane-side-effects', 'non-text', 'Trial Strip side-effect marks'),
  ...onSurfaces('lane-taken', 'non-text', 'Trial Strip adherence ticks'),
  ...onSurfaces('lane-barriers', 'non-text', 'Trial Strip barrier glyphs'),
];

/** Colours that are decorative only: never text, never a control's only boundary. */
export const DECORATIVE: readonly ColourName[] = ['rule'];

/** Spec 21.3. Self-hosted font files arrive with the first app (licence review in its ADR). */
export const TYPE = {
  fontBody: "'Atkinson Hyperlegible Next', system-ui, sans-serif",
  fontReading: "'Literata', Georgia, serif",
  /** rem, base 16 px. */
  scale: {
    xs: 0.8125,
    sm: 0.875,
    md: 1,
    lg: 1.125,
    xl: 1.375,
    '2xl': 1.75,
    '3xl': 2.25,
  },
  lineHeightBody: 1.5,
  lineHeightTitle: 1.2,
  measure: '66ch',
} as const;

/** Spec 21.5: 4 px grid. */
export const SPACE = [4, 8, 12, 16, 24, 32, 48, 64] as const;
/** Spec 21.5: two radii only. */
export const RADIUS = { control: 4, sheet: 12 } as const;
/** Spec 21.5: motion only to show change; all off with prefers-reduced-motion. */
export const MOTION = {
  state: { ms: 150, easing: 'ease-out' },
  sheet: { ms: 220, easing: 'ease-out' },
} as const;
/** Spec 21.4 and 21.10. */
export const FOCUS = { widthPx: 3, offsetPx: 2 } as const;
export const TARGET_MIN_PX = 44;

const colours = (p: Partial<Palette>, indent: string) => {
  const set = new Map<string, string>(Object.entries(p));
  // In COLOUR_NAMES order, so the generated file is stable.
  return COLOUR_NAMES.flatMap((n) => {
    const v = set.get(n);
    return v === undefined ? [] : [`${indent}--${n}: ${v.toLowerCase()};`];
  }).join('\n');
};

/** The CSS custom properties for both apps, generated from the tokens above. */
export function tokensCss(): string {
  const scale = Object.entries(TYPE.scale)
    .map(([k, v]) => `  --text-${k}: ${String(v)}rem;`)
    .join('\n');
  return `/* Generated from packages/ui/src/tokens/tokens.ts by \`pnpm --filter @endo/ui tokens:css\`. Do not edit. */
:root {
  color-scheme: light dark;
${colours(LIGHT, '  ')}
  --font-body: ${TYPE.fontBody};
  --font-reading: ${TYPE.fontReading};
${scale}
  --line-height-body: ${String(TYPE.lineHeightBody)};
  --line-height-title: ${String(TYPE.lineHeightTitle)};
  --measure: ${TYPE.measure};
${SPACE.map((s) => `  --space-${String(s)}: ${String(s)}px;`).join('\n')}
  --radius-control: ${String(RADIUS.control)}px;
  --radius-sheet: ${String(RADIUS.sheet)}px;
  --motion-state: ${String(MOTION.state.ms)}ms ${MOTION.state.easing};
  --motion-sheet: ${String(MOTION.sheet.ms)}ms ${MOTION.sheet.easing};
  --focus-width: ${String(FOCUS.widthPx)}px;
  --focus-offset: ${String(FOCUS.offsetPx)}px;
  --target-min: ${String(TARGET_MIN_PX)}px;
}

@media (prefers-color-scheme: dark) {
  :root {
${colours(DARK, '    ')}
  }
}

@media (prefers-contrast: more) {
  :root {
${colours(MORE_CONTRAST.light, '    ')}
  }
}

@media (prefers-contrast: more) and (prefers-color-scheme: dark) {
  :root {
${colours(MORE_CONTRAST.dark, '    ')}
  }
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --motion-state: 0ms linear;
    --motion-sheet: 0ms linear;
  }
}
`;
}
