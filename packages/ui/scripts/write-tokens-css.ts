// Writes src/tokens/tokens.css from the token source. Run: pnpm --filter @endo/ui tokens:css
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tokensCss } from '../src/tokens/tokens.ts';

// A fixed path inside this package, never input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
writeFileSync(fileURLToPath(new URL('../src/tokens/tokens.css', import.meta.url)), tokensCss());
