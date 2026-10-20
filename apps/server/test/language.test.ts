import { describe, expect, it } from 'vitest';
import { guessLanguage, languageName } from '../src/ai/language.js';

describe('guessLanguage', () => {
  it('recognises common languages from short questions', () => {
    expect(guessLanguage('What are the best tips for beginners in Hollow Knight?')).toBe('en');
    expect(guessLanguage('Wie baue ich in Factorio einen guten Main Bus?')).toBe('de');
    expect(guessLanguage('Quelle est la meilleure recette pour le pain?')).toBe('fr');
    expect(guessLanguage('¿Cuál es la mejor manera de aprender Python?')).toBe('es');
  });

  it('gives up when there is not enough signal', () => {
    expect(guessLanguage('Factorio')).toBeNull();
    expect(guessLanguage('Elden Ring Malenia')).toBeNull();
  });

  it('names languages for prompts', () => {
    expect(languageName('de')).toBe('German');
    expect(languageName('ja')).toBe('ja');
  });
});
