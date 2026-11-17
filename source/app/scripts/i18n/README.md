# Translations

Interface strings are keyed by their English text (`tr("Save")` in the code).
English is the fallback, so a missing translation shows in English.

- `i18n-keys.json` — every English string, in a fixed order (new ones are appended).
- `pl.txt`, `de.txt`, `fr.txt`, `it.txt`, `zh.txt` — one line per string: `index|translation`.
  `{0}`, `{1}` are filled in at run time. Placeholders glued to an English word
  (`page{1}` = the plural "s") may be left out.
- `python3 i18n-build.py pl de fr it zh` — checks every line and placeholder and
  writes `src/locales/<lang>.json`.
- `node i18n-collect.mjs ../../src out.json` (run from `source/app`) lists the
  strings in the code; `i18n-leftovers.mjs` finds English sentences not yet in `tr()`.
