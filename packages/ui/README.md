# @endo/ui

**Purpose:** the design system shared by the patient app and the clinician desk (spec 21). This first part is deliverable 1 of spec 21.12: the design tokens and their automated contrast test. Components arrive with the first screens.

**Owners:** platform engineering; colour and typography changes need design review.

## Public API

| Export                                                             | What it does                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@endo/ui/tokens.css`                                              | CSS custom properties for colour, type, space, shape, motion, focus and target size, with dark mode, `prefers-contrast: more` and `prefers-reduced-motion`. Generated; never edit by hand                                              |
| `LIGHT`, `DARK`, `MORE_CONTRAST`                                   | The palettes of spec 21.4, plus `on-action`, `control-border` and `focus-ring` (documented in `tokens.ts`)                                                                                                                             |
| `COLOUR_PAIRS`, `DECORATIVE`                                       | Every allowed foreground/background pairing and its use (text, AAA text, non-text). Colours in `DECORATIVE` (`rule`) are never text or a control's only boundary                                                                       |
| `TYPE`, `SPACE`, `RADIUS`, `MOTION`, `FOCUS`, `TARGET_MIN_PX`      | Spec 21.3 and 21.5 scales                                                                                                                                                                                                              |
| `contrastRatio`, `relativeLuminance`, `MINIMUM_CONTRAST`           | WCAG 2.2 contrast, as the specification defines it                                                                                                                                                                                     |
| `@endo/ui/trial-strip`: `stripModel`, `describeWeek`, `TrialStrip` | Spec 21.6: the weeks of a trial as four lanes (benefit against the first week, side effects, days taken, barriers); missing weeks are "No entry", never zero. `TrialStrip` draws it as SVG with an equivalent table for screen readers |

## Rules the tests enforce

- Every listed pairing meets WCAG 2.2 in light, dark and both more-contrast modes: 4.5:1 for text, 7:1 for the verdict sentence and titles, 3:1 for control boundaries, the focus ring and Trial Strip marks.
- `critical` is used for red flags only. The four lanes and `critical` are distinct colours (words and shapes still carry the meaning).
- No gradients or shadows in the tokens. Only the specified type scale, 4 px spacing and two radii.
- `tokens.css` is exactly what `tokensCss()` generates. After changing `tokens.ts`, run `pnpm --filter @endo/ui tokens:css`.

## Not yet

The self-hosted fonts (Atkinson Hyperlegible Next, Literata; SIL Open Font Licence) are added with the first app, with their licence review in its ADR. Until then the font stacks fall back to system fonts.
