# @endo/i18n

**Purpose:** every user-facing string for both apps (spec 21.9). Components never contain text; they call `t(key)`.

**Owners:** product and design; patient-facing wording changes need content review, and anything clinical comes only from signed-off `clinical/` files (spec 0 rule 5).

## Public API

| Export                   | What it does                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `translator(locale)`     | Returns `t(key, vars?)`. `{name}` placeholders are filled with plain text; a missing value throws |
| `MessageKey`, `Messages` | The typed keys: a missing key in any language is a build error                                    |
| `CATALOGUES`             | The shipped languages (English now; others per spec Section 24 item 9)                            |

## Rules the tests enforce

No exclamation marks, no emoji, none of "just", "only", "mild discomfort", "oops", "sorry", and no all-caps words. Every language has every key.
