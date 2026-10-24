import { useEffect, useState } from 'react';
import { BellRing, Pause, Play, Timer as TimerIcon, X } from 'lucide-react';
import { findDurations } from '@nicotes/shared';

export interface Timer {
  id: number;
  label: string;
  total: number;
  /** When it rings; null while paused. */
  endsAt: number | null;
  /** Seconds left while paused. */
  remaining: number;
  done: boolean;
}

/** A short beep pattern, and a buzz on phones. */
function ring() {
  navigator.vibrate?.([300, 150, 300, 150, 300]);
  try {
    const ctx = new AudioContext();
    [0, 0.35, 0.7].forEach((at) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.25, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.26);
    });
    setTimeout(() => void ctx.close(), 1500);
  } catch {
    // No audio (e.g. blocked autoplay): the timer still shows as done.
  }
}

export function useTimers() {
  const [timers, setTimers] = useState<Timer[]>([]);
  const [now, setNow] = useState(Date.now());
  const running = timers.some((t) => t.endsAt !== null && !t.done);

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      const t = Date.now();
      setNow(t);
      setTimers((list) =>
        list.map((timer) => {
          if (timer.done || timer.endsAt === null || timer.endsAt > t) return timer;
          ring();
          return { ...timer, done: true, remaining: 0 };
        }),
      );
    }, 500);
    return () => clearInterval(interval);
  }, [running]);

  return {
    timers,
    now,
    start: (label: string, seconds: number) =>
      setTimers((list) => [
        ...list,
        { id: Date.now() + Math.random(), label, total: seconds, endsAt: Date.now() + seconds * 1000, remaining: seconds, done: false },
      ]),
    toggle: (id: number) =>
      setTimers((list) =>
        list.map((t) =>
          t.id !== id || t.done
            ? t
            : t.endsAt === null
              ? { ...t, endsAt: Date.now() + t.remaining * 1000 }
              : { ...t, endsAt: null, remaining: Math.max(0, Math.round((t.endsAt - Date.now()) / 1000)) },
        ),
      ),
    remove: (id: number) => setTimers((list) => list.filter((t) => t.id !== id)),
  };
}

export type Timers = ReturnType<typeof useTimers>;

const clock = (seconds: number) => {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

/** Buttons for the durations a step mentions ("bake 10 minutes" → a 10-minute timer). */
export function TimerChips({ text, timers }: { text: string; timers: Timers }) {
  const found = findDurations(text);
  if (!found.length) return null;
  return (
    <span className="timer-chips">
      {found.map((d, i) => (
        <button key={i} className="timer-chip" onClick={() => timers.start(d.label, d.seconds)} title="Start a timer">
          <TimerIcon size={13} /> {d.label}
        </button>
      ))}
    </span>
  );
}

/** Running timers, floating in the corner. */
export function TimerTray({ timers }: { timers: Timers }) {
  if (!timers.timers.length) return null;
  return (
    <div className="timer-tray" role="status" aria-label="Timers">
      {timers.timers.map((t) => {
        const left = t.endsAt === null ? t.remaining : (t.endsAt - timers.now) / 1000;
        return (
          <div key={t.id} className={t.done ? 'timer done' : t.endsAt === null ? 'timer paused' : 'timer'}>
            {t.done ? <BellRing size={15} /> : <TimerIcon size={15} />}
            <span className="timer-time">{t.done ? 'Done' : clock(left)}</span>
            <span className="timer-label">{t.label}</span>
            {!t.done && (
              <button className="icon-btn" aria-label={t.endsAt === null ? 'Resume timer' : 'Pause timer'} onClick={() => timers.toggle(t.id)}>
                {t.endsAt === null ? <Play size={14} /> : <Pause size={14} />}
              </button>
            )}
            <button className="icon-btn" aria-label="Remove timer" onClick={() => timers.remove(t.id)}>
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
