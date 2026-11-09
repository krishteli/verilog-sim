import { describe, expect, it } from 'vitest';
import { formatValue, indexAt, niceStep, valueAt } from './wave-utils';

describe('waveform helpers', () => {
  it('formats values in each radix', () => {
    expect(formatValue(10n, 8, 'hex')).toBe('0a');
    expect(formatValue(5n, 4, 'bin')).toBe('0101');
    expect(formatValue(254n, 8, 'udec')).toBe('254');
    expect(formatValue(254n, 8, 'sdec')).toBe('-2');
  });

  it('finds the value in effect at a time', () => {
    const w = { times: [0, 10, 20], values: [1n, 2n, 3n] };
    expect(indexAt(w, 0)).toBe(0);
    expect(indexAt(w, 9)).toBe(0);
    expect(indexAt(w, 10)).toBe(1);
    expect(valueAt(w, 15)).toBe(2n);
    expect(valueAt(w, 1000)).toBe(3n);
  });

  it('picks 1-2-5 tick steps', () => {
    expect(niceStep(10)).toBe(10); // 80px / 10px per unit = 8 -> 10
    expect(niceStep(1)).toBe(100);
    expect(niceStep(0.3)).toBe(500);
    expect(niceStep(1000)).toBe(1); // never below one time unit
  });
});
