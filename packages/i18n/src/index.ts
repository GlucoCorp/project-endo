import { en, type MessageKey, type Messages } from './en.ts';

export type { MessageKey, Messages } from './en.ts';

/** The languages that ship; each must provide every key (spec 21.9). */
export const CATALOGUES: Readonly<Record<'en', Messages>> = { en };
export type Locale = keyof typeof CATALOGUES;

/**
 * Fills `{name}` placeholders with plain text: never markup (spec 12.2). A missing value is an
 * error rather than a silent gap.
 */
export function format(template: string, vars: Readonly<Record<string, string>> = {}): string {
  const values = new Map(Object.entries(vars));
  return template.replace(/\{([a-z-]+)\}/g, (_, name: string) => {
    const v = values.get(name);
    if (v === undefined) throw new Error(`missing value for {${name}}`);
    return v;
  });
}

/** A translator for one locale: `t(key, vars?)`. */
export function translator(locale: Locale = 'en') {
  const catalogue = new Map<string, Messages>(Object.entries(CATALOGUES)).get(locale);
  if (!catalogue) throw new Error(`unknown locale: ${locale}`);
  const messages = new Map<string, string>(Object.entries(catalogue));
  return (key: MessageKey, vars: Readonly<Record<string, string>> = {}): string => {
    const template = messages.get(key);
    // Keys are typed; this guards values that arrive untyped (for example from a route).
    if (template === undefined) throw new Error(`unknown message: ${key}`);
    return format(template, vars);
  };
}
