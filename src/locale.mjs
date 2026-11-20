// Language preference validation. "auto" (default) means: follow the user's conversation language.
// Any valid BCP 47 language tag is accepted. There is no hardcoded ko/en/ja allowlist.
import { canonicalTag, envLocaleHint } from './hook-runner.mjs';
import { usageError } from './util.mjs';

export { envLocaleHint };

export function normalizeLanguage(input) {
  const s = String(input ?? '').trim();
  if (!s) throw usageError('Missing language. Use "auto" or a BCP 47 language tag such as ko, en, ja, fr, pt-BR, zh-CN.');
  if (s.toLowerCase() === 'auto') return 'auto';
  const tag = canonicalTag(s);
  if (!tag) throw usageError(`Invalid language tag "${s}". Use "auto" or a BCP 47 language tag such as ko, en, ja, fr, pt-BR, zh-CN.`);
  return tag;
}

export function languageName(tag) {
  if (tag === 'auto') return 'auto';
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(tag);
    return name && name !== tag ? name : tag;
  } catch {
    return tag;
  }
}

export function describeLanguage(lang) {
  return lang === 'auto' ? 'auto (follow the user)' : `${languageName(lang)} (${lang}) preferred`;
}
