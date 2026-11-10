/**
 * WCAG 2.2 contrast (success criteria 1.4.3, 1.4.6 and 1.4.11), computed exactly as the
 * specification defines it: relative luminance of sRGB colours, then (L1 + 0.05) / (L2 + 0.05).
 */

const HEX = /^#[0-9A-Fa-f]{6}$/;

function channel(hex: string, at: number): number {
  const v = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a `#RRGGBB` colour, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  if (!HEX.test(hex)) throw new TypeError(`not a #RRGGBB colour: ${hex}`);
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** Contrast ratio between two colours, 1 to 21, whichever is lighter. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** The minimum ratio for each kind of use (WCAG 2.2). */
export const MINIMUM_CONTRAST = {
  /** Body and UI text, AA (1.4.3). */
  text: 4.5,
  /** The verdict sentence and other text where the spec asks for AAA (1.4.6). */
  'text-aaa': 7,
  /** Control boundaries, focus indicators and meaningful graphics (1.4.11). */
  'non-text': 3,
} as const;
export type ContrastUse = keyof typeof MINIMUM_CONTRAST;
