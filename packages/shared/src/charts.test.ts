import { describe, expect, it } from 'vitest';
import { parseNumber, tableChart } from './charts';

describe('charts from tables', () => {
  it('reads numbers the way people write them', () => {
    expect(['12.3', '1,234.5', '1.234,5', '12,5', '1,234', '−4 °C', '-4', '45 %', '12.3 kWh', '1 234', '**7**'].map(parseNumber)).toEqual([
      12.3, 1234.5, 1234.5, 12.5, 1234, -4, -4, 45, 12.3, 1234, 7,
    ]);
    expect(['', 'n/a', 'sunny', '—'].map(parseNumber)).toEqual([null, null, null, null]);
  });

  it('turns a logbook into series over time', () => {
    const chart = tableChart(
      [
        '| Date | Solar (kWh) | Temperature | Weather |',
        '|---|---|---|---|',
        '| 2026-11-01 | 12.3 | 8 °C | rain |',
        '| 2026-11-02 | 15,1 | 10 °C | sun |',
        '| 2026-11-03 | – | 9 °C | cloudy |',
      ].join('\n'),
    );
    expect(chart).toEqual({
      xLabel: 'Date',
      x: ['2026-11-01', '2026-11-02', '2026-11-03'],
      kind: 'time',
      series: [
        { name: 'Solar', unit: 'kWh', values: [12.3, 15.1, null] },
        { name: 'Temperature', unit: '°C', values: [8, 10, 9] },
      ],
    });
  });

  it('charts categories as such, and leaves tables without numbers alone', () => {
    expect(tableChart('| Room | Area |\n|---|---|\n| Kitchen | 12 |\n| Hall | 6 |')?.kind).toBe('category');
    expect(tableChart('| Name | Notes |\n|---|---|\n| a | b |\n| c | d |')).toBeNull();
    expect(tableChart('| Day | kWh |\n|---|---|\n| Mon | 3 |')).toBeNull();
  });
});
