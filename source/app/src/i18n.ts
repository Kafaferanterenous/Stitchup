//! Interface languages. Strings are keyed by their English text, so English is
//! always the fallback: anything not (yet) translated simply shows in English.
//! Values may contain {0}, {1}… for numbers / names filled in at run time.

import pl from "./locales/pl.json";
import it from "./locales/it.json";
import de from "./locales/de.json";
import fr from "./locales/fr.json";
import zh from "./locales/zh.json";

export type Lang = "en" | "pl" | "it" | "de" | "fr" | "zh";

export const LANGUAGES: { code: Lang; name: string }[] = [
  { code: "en", name: "English" },
  { code: "pl", name: "Polski" },
  { code: "it", name: "Italiano" },
  { code: "de", name: "Deutsch" },
  { code: "fr", name: "Français" },
  { code: "zh", name: "中文（简体）" },
];

const TABLES: Record<Exclude<Lang, "en">, Record<string, string>> = { pl, it, de, fr, zh };

const KEY = "stitchup.language";

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY) as Lang | null;
    if (saved && LANGUAGES.some((l) => l.code === saved)) return saved;
  } catch {
    /* no storage */
  }
  // First run: the system language when we have it.
  const sys = (navigator.language || "en").slice(0, 2).toLowerCase();
  return (LANGUAGES.find((l) => l.code === sys)?.code ?? "en") as Lang;
}

let current: Lang = initial();
const listeners = new Set<() => void>();

export function language(): Lang {
  return current;
}

export function setLanguage(l: Lang) {
  current = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* not remembered */
  }
  document.documentElement.lang = l === "zh" ? "zh-Hans" : l;
  listeners.forEach((f) => f());
}

/** Called when the language changes (UI re-render, native menu rebuild). */
export function onLanguageChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Translate `en` (the English text) into the current language. */
export function tr(en: string, ...args: unknown[]): string {
  const t = current === "en" ? en : TABLES[current][en] ?? en;
  const filled = args.length ? t.replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m)) : t;
  return current === "pl" ? polishTypography(filled) : filled;
}

/** Polish typesetting: a one-letter word (a, i, o, u, w, z) never ends a
 *  line — it is bound to the next word with a non-breaking space. */
export function polishTypography(s: string): string {
  return s.replace(/(^|[\s(„«])([aiouwzAIOUWZ]) (?=\S)/g, "$1$2\u00a0");
}

if (typeof document !== "undefined") document.documentElement.lang = current === "zh" ? "zh-Hans" : current;
