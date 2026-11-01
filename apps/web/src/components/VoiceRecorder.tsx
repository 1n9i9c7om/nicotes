import { useEffect, useRef, useState } from 'react';
import { Mic, Square, X } from 'lucide-react';
import { localDate } from '../lib/daily';

/** Recording needs a microphone API and HTTPS (or localhost). */
export const recordingSupported = () =>
  window.isSecureContext && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

/** Formats that browsers record and transcription services read: Opus in WebM (Chrome, Firefox), AAC in MP4 (Safari). */
const FORMATS = [
  { mime: 'audio/webm;codecs=opus', ext: 'webm' },
  { mime: 'audio/mp4', ext: 'm4a' },
  { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
];
const MAX_SECONDS = 30 * 60;

export const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * Records from the microphone as soon as it opens; "Stop and add" hands over the file. Long
 * recordings stop by themselves after 30 minutes.
 */
export function VoiceRecorder({ onDone, onClose }: { onDone: (file: File, seconds: number) => void; onClose: () => void }) {
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const keep = useRef(false);
  const elapsed = useRef(0);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch (err) {
        const name = (err as Error).name;
        setError(
          name === 'NotAllowedError'
            ? 'Microphone access is blocked. Allow it for this site in the browser, then try again.'
            : name === 'NotFoundError'
              ? 'No microphone found.'
              : `The microphone could not be opened: ${(err as Error).message}`,
        );
        return;
      }
      if (cancelled) return stream.getTracks().forEach((t) => t.stop());
      const format = FORMATS.find((f) => MediaRecorder.isTypeSupported(f.mime)) ?? FORMATS[0]!;
      const rec = new MediaRecorder(stream, { mimeType: format.mime, audioBitsPerSecond: 48_000 });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream?.getTracks().forEach((t) => t.stop());
        if (!keep.current) return;
        const type = format.mime.split(';')[0]!;
        const time = new Date().toTimeString().slice(0, 5).replace(':', '-');
        done.current(new File(chunks, `Voice note ${localDate()} ${time}.${format.ext}`, { type }), elapsed.current);
      };
      rec.start(1000);
      recorder.current = rec;
      setRecording(true);
      timer = setInterval(() => {
        elapsed.current += 1;
        setSeconds(elapsed.current);
        if (elapsed.current >= MAX_SECONDS) stop(true);
      }, 1000);
    })();
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (recorder.current?.state === 'recording') recorder.current.stop();
      else stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const stop = (add: boolean) => {
    keep.current = add;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    onClose();
  };

  return (
    <div className="voice-recorder" role="dialog" aria-label="Voice note" onKeyDown={(e) => e.key === 'Escape' && stop(false)}>
      {error ? (
        <p className="error">{error}</p>
      ) : (
        <span className={`voice-status${recording ? ' live' : ''}`} role="status">
          <Mic size={15} /> {recording ? `Recording ${duration(seconds)}` : 'Opening the microphone…'}
        </span>
      )}
      <div className="voice-actions">
        {!error && (
          <button type="button" className="btn btn-sm btn-primary" disabled={!recording} onClick={() => stop(true)}>
            <Square size={13} /> Stop and add
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={() => stop(false)}>
          <X size={13} /> {error ? 'Close' : 'Discard'}
        </button>
      </div>
    </div>
  );
}
