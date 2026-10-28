import { describe, expect, it } from 'vitest';
import { rangeMiddle, rangeStep, shortDuration } from './Timers';

describe('range timers', () => {
  it('start in the middle of the range, on whole steps', () => {
    expect(rangeMiddle({ label: '10–25 minutes', seconds: 600, max: 1500 })).toBe(1080);
    expect(rangeMiddle({ label: '20–30 minutes', seconds: 1200, max: 1800 })).toBe(1500);
    expect(rangeMiddle({ label: '30–45 seconds', seconds: 30, max: 45 })).toBe(40);
    expect(rangeMiddle({ label: '1–2 hours', seconds: 3600, max: 7200 })).toBe(5400);
  });

  it('adjust in steps that suit the range', () => {
    expect(rangeStep(15)).toBe(5);
    expect(rangeStep(900)).toBe(60);
    expect(rangeStep(5400)).toBe(300);
  });

  it('show short durations', () => {
    expect(shortDuration(45)).toBe('45 s');
    expect(shortDuration(1080)).toBe('18 min');
    expect(shortDuration(90)).toBe('1:30 min');
    expect(shortDuration(5400)).toBe('1 h 30 min');
    expect(shortDuration(7200)).toBe('2 h');
  });
});
