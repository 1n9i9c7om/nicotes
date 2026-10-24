/**
 * Tiny stop-word language guesser. Small, fast models (e.g. GLM 5.3 FlashX at minimal
 * reasoning) sometimes answer in the wrong language when asked to "match the language",
 * so prompts name the language explicitly when this detects one confidently.
 */
const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'is', 'are', 'what', 'which', 'how', 'for', 'with', 'of', 'to', 'in', 'a', 'it', 'on', 'best', 'do', 'does', 'can', 'my', 'this', 'that', 'from', 'about', 'than', 'but'],
  de: ['der', 'die', 'das', 'und', 'ist', 'sind', 'wie', 'was', 'welche', 'für', 'mit', 'ein', 'eine', 'ich', 'nicht', 'auf', 'zu', 'den', 'im', 'beste', 'besten', 'baue', 'kann', 'auch', 'oder', 'aber'],
  fr: ['le', 'la', 'les', 'et', 'est', 'sont', 'comment', 'quel', 'quelle', 'pour', 'avec', 'un', 'une', 'des', 'du', 'je', 'pas', 'sur', 'dans', 'meilleur', 'que', 'qui'],
  es: ['el', 'la', 'los', 'las', 'y', 'es', 'son', 'cómo', 'como', 'qué', 'cuál', 'para', 'con', 'un', 'una', 'del', 'yo', 'no', 'en', 'mejor', 'que', 'por'],
  it: ['il', 'lo', 'la', 'gli', 'e', 'è', 'sono', 'come', 'quale', 'per', 'con', 'un', 'una', 'del', 'della', 'io', 'non', 'su', 'migliore', 'che', 'di'],
  nl: ['de', 'het', 'een', 'en', 'is', 'zijn', 'hoe', 'wat', 'welke', 'voor', 'met', 'ik', 'niet', 'op', 'van', 'beste', 'kan', 'ook', 'maar'],
};

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  nl: 'Dutch',
};

/** ISO 639-1 code of the text's language, or null when not confident. */
export function guessLanguage(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (words.length < 2) return null;
  const scores = Object.entries(STOPWORDS).map(([lang, list]) => {
    const set = new Set(list);
    // German umlauts and ß are strong signals on their own.
    const bonus = lang === 'de' && /[äöüß]/i.test(text) ? 2 : 0;
    return [lang, words.filter((w) => set.has(w)).length + bonus] as const;
  });
  scores.sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  return best && best[1] >= 2 && best[1] > (second?.[1] ?? 0) ? best[0] : null;
}

/** "German" for "de", the code itself for unknown codes. */
export const languageName = (code: string) => LANGUAGE_NAMES[code.toLowerCase()] ?? code;
