/**
 * Tags are case-insensitive and stored normalised: lowercase, words joined by "-",
 * "/" allowed for hierarchies (e.g. `gaming/rpg`). A leading "#" is dropped.
 */
export function normalizeTag(input: string): string {
  return input
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_\-/]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-/]+|[-/]+$/g, '')
    .slice(0, 64);
}
