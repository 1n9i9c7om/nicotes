import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BookOpen, Pause, Play, RotateCcw } from 'lucide-react';
import { guessLanguage } from '@nicotes/shared';
import { useLocalState } from '../../lib/storage';
import { plainText, type LayoutProps } from './types';

interface Sentence {
  index: number;
  text: string;
}

interface Part {
  key: string;
  kind: 'heading' | 'text' | 'item' | 'quote';
  level: number;
  sentences: Sentence[];
}

const speech = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;

function splitSentences(text: string, lang: string): string[] {
  if ('Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' });
    return [...segmenter.segment(text)].map((s) => s.segment.trim()).filter(Boolean);
  }
  return text.split(/(?<=[.!?…])\s+/).filter(Boolean);
}

/**
 * The voices for a language, voices on the device first (they report word positions). Without
 * one for the language, all voices are offered and `exact` is false.
 */
function useVoices(lang: string) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => speech?.getVoices() ?? []);
  useEffect(() => {
    if (!speech) return;
    const load = () => setVoices(speech.getVoices());
    load();
    speech.addEventListener('voiceschanged', load);
    return () => speech.removeEventListener('voiceschanged', load);
  }, []);
  const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase()));
  const list = (matching.length ? matching : voices).sort((a, b) => Number(b.localService) - Number(a.localService));
  return { voices: list, exact: matching.length > 0 };
}

/**
 * A story or article to read, or to listen to: the browser reads it aloud sentence by
 * sentence (on the device, no AI) and highlights the sentence and word being spoken. Clicking
 * a sentence reads from there; the position is remembered per page.
 */
export function ReaderLayout({ pageId, blocks, spec }: LayoutProps) {
  const lang = spec.language ?? guessLanguage(blocks.map((b) => ('text' in b ? b.text : '')).join(' ').slice(0, 4000)) ?? navigator.language.slice(0, 2);
  const parts = useMemo(() => {
    let index = 0;
    const result: Part[] = [];
    const add = (key: string, kind: Part['kind'], level: number, text: string) => {
      const plain = plainText(text);
      if (!plain) return;
      result.push({ key, kind, level, sentences: splitSentences(plain, lang).map((s) => ({ index: index++, text: s })) });
    };
    for (const block of blocks) {
      if (block.kind === 'heading') add(block.key, 'heading', block.level, block.text);
      else if (block.kind === 'paragraph') add(block.key, 'text', 0, block.text);
      else if (block.kind === 'quote') add(block.key, 'quote', 0, block.text.replace(/\n/g, ' '));
      else if (block.kind === 'list') block.items.forEach((item, n) => add(`${block.key}:${n}`, 'item', item.depth, item.text));
    }
    return result;
  }, [blocks, lang]);
  const sentences = useMemo(() => parts.flatMap((p) => p.sentences), [parts]);

  const { voices, exact } = useVoices(lang);
  const languageName = new Intl.DisplayNames(['en'], { type: 'language' }).of(lang) ?? lang;
  const [voiceUri, setVoiceUri] = useLocalState(`nicotes.voice.${lang}`, '');
  const [rate, setRate] = useLocalState('nicotes.readRate', 1);
  const [stored, setPosition] = useLocalState(`nicotes.read.${pageId}`, 0);
  const position = Math.min(stored, Math.max(sentences.length - 1, 0));
  const [playing, setPlaying] = useState(false);
  const [word, setWord] = useState<{ start: number; end: number } | null>(null);
  // Each utterance gets a token; events of cancelled ones are ignored.
  const token = useRef(0);
  const voice = voices.find((v) => v.voiceURI === voiceUri) ?? voices[0];

  const speak = (i: number) => {
    if (!speech) return;
    const sentence = sentences[i];
    const mine = ++token.current;
    speech.cancel();
    setWord(null);
    if (!sentence) {
      setPlaying(false);
      setPosition(0);
      return;
    }
    setPosition(i);
    const utterance = new SpeechSynthesisUtterance(sentence.text);
    utterance.lang = voice?.lang ?? lang;
    if (voice) utterance.voice = voice;
    utterance.rate = rate;
    utterance.onboundary = (e) => {
      if (token.current !== mine || e.name !== 'word') return;
      const length = e.charLength || /^\S+/.exec(sentence.text.slice(e.charIndex))?.[0].length || 0;
      setWord({ start: e.charIndex, end: e.charIndex + length });
    };
    utterance.onend = () => {
      if (token.current === mine) speak(i + 1);
    };
    utterance.onerror = (e) => {
      if (token.current === mine && e.error !== 'interrupted' && e.error !== 'canceled') setPlaying(false);
    };
    speech.speak(utterance);
  };

  const pause = () => {
    token.current++;
    speech?.cancel();
    setPlaying(false);
    setWord(null);
  };

  // Stop speaking when leaving the page; a new speed or voice restarts the current sentence.
  useEffect(
    () => () => {
      token.current++;
      speech?.cancel();
    },
    [],
  );
  useEffect(() => {
    if (playing) speak(position);
  }, [rate, voiceUri]);

  const current = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (playing) current.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [position, playing]);

  const words = sentences.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
  const minutes = Math.max(1, Math.round(words / 200));

  const sentence = (s: Sentence): ReactNode => {
    const active = s.index === position && (playing || position > 0);
    let body: ReactNode = s.text;
    if (active && word && playing) {
      body = (
        <>
          {s.text.slice(0, word.start)}
          <mark className="reader-word">{s.text.slice(word.start, word.end)}</mark>
          {s.text.slice(word.end)}
        </>
      );
    }
    return (
      <span
        key={s.index}
        ref={active ? current : undefined}
        className={active ? 'reader-sentence current' : 'reader-sentence'}
        onClick={() => (playing ? speak(s.index) : setPosition(s.index))}
      >
        {body}{' '}
      </span>
    );
  };

  return (
    <div className="reader">
      <div className="reader-bar">
        {speech ? (
          <>
            <button
              className="btn btn-primary"
              onClick={() => (playing ? pause() : (setPlaying(true), speak(position)))}
              aria-label={playing ? 'Pause reading' : 'Read aloud'}
            >
              {playing ? <Pause size={16} /> : <Play size={16} />} {playing ? 'Pause' : position > 0 ? 'Continue' : 'Read aloud'}
            </button>
            {position > 0 && (
              <button
                className="icon-btn"
                aria-label="Back to the start"
                title="Back to the start"
                onClick={() => (playing ? speak(0) : setPosition(0))}
              >
                <RotateCcw size={16} />
              </button>
            )}
            <select value={rate} onChange={(e) => setRate(Number(e.target.value))} aria-label="Speed">
              {[0.75, 1, 1.25, 1.5, 1.75].map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
            {voices.length > 1 && (
              <select value={voice?.voiceURI ?? ''} onChange={(e) => setVoiceUri(e.target.value)} aria-label="Voice">
                {voices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name}
                  </option>
                ))}
              </select>
            )}
          </>
        ) : (
          <span className="muted">Reading aloud is not available in this browser.</span>
        )}
        {speech && voices.length > 0 && !exact && (
          <span className="reader-hint muted" title="Voices come from the operating system or browser">
            No {languageName} voice on this device
          </span>
        )}
        <span className="reader-meta muted">
          <BookOpen size={14} /> {minutes} min read
          {position > 0 && ` · ${Math.round((position / Math.max(sentences.length - 1, 1)) * 100)}%`}
        </span>
      </div>
      <div className="reader-progress" aria-hidden="true">
        <span style={{ width: `${sentences.length > 1 ? (position / (sentences.length - 1)) * 100 : 0}%` }} />
      </div>

      <article className="reader-text" lang={lang}>
        {parts.map((part) => {
          const body = part.sentences.map(sentence);
          if (part.kind === 'heading') {
            const Tag = part.level <= 1 ? 'h1' : part.level === 2 ? 'h2' : 'h3';
            return <Tag key={part.key}>{body}</Tag>;
          }
          if (part.kind === 'quote') return <blockquote key={part.key}>{body}</blockquote>;
          if (part.kind === 'item') {
            return (
              <p key={part.key} className="reader-item" style={{ marginLeft: part.level * 22 }}>
                {body}
              </p>
            );
          }
          return <p key={part.key}>{body}</p>;
        })}
      </article>
    </div>
  );
}
