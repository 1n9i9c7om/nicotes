import { describe, expect, it } from 'vitest';
import { addDays, dueBucket, dueLabel } from './tasks';

describe('due dates', () => {
  const today = '2026-10-20'; // a Tuesday

  it('groups by how soon a task is due', () => {
    expect(dueBucket(null, today)).toBe('none');
    expect(dueBucket('2026-10-19', today)).toBe('overdue');
    expect(dueBucket(today, today)).toBe('today');
    expect(dueBucket('2026-10-21', today)).toBe('tomorrow');
    expect(dueBucket('2026-10-27', today)).toBe('week');
    expect(dueBucket('2026-10-28', today)).toBe('later');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('labels dates relative to today', () => {
    expect(dueLabel(today, today)).toBe('Today');
    expect(dueLabel('2026-10-21', today)).toBe('Tomorrow');
    expect(dueLabel('2026-10-19', today)).toBe('Yesterday');
    expect(dueLabel('2026-10-23', today)).toBe('Friday');
    expect(dueLabel('2026-11-03', today)).toBe('3 Nov');
    expect(dueLabel('2027-01-05', today)).toBe('5 Jan 2027');
  });
});
