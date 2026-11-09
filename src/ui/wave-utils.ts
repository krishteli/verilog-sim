import { toSigned } from '../core/bits';
import type { Wave } from '../core';

export type Radix = 'hex' | 'bin' | 'udec' | 'sdec';

export const RADIX_LABEL: Record<Radix, string> = { hex: 'hex', bin: 'bin', udec: 'dec', sdec: '±dec' };
export const RADIX_ORDER: Radix[] = ['hex', 'bin', 'udec', 'sdec'];

/** Format a value for display in the waveform. Hex and binary keep leading zeros so widths are visible. */
export function formatValue(value: bigint, width: number, radix: Radix): string {
  switch (radix) {
    case 'hex':
      return value.toString(16).padStart(Math.ceil(width / 4), '0');
    case 'bin':
      return value.toString(2).padStart(width, '0');
    case 'udec':
      return value.toString();
    case 'sdec':
      return toSigned(value, width).toString();
  }
}

/** Index of the change in effect at time `t` (the last entry with times[i] <= t), by binary search. */
export function indexAt(wave: Wave, t: number): number {
  const { times } = wave;
  let lo = 0;
  let hi = times.length - 1;
  if (t < times[0]!) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function valueAt(wave: Wave, t: number): bigint {
  return wave.values[indexAt(wave, t)]!;
}

/**
 * A "nice" tick spacing for the time axis: the smallest of 1, 2, 5 x 10^n
 * that leaves at least `minPx` pixels between labels.
 */
export function niceStep(pxPerUnit: number, minPx = 80): number {
  const raw = minPx / pxPerUnit;
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
  for (const m of [1, 2, 5, 10]) {
    if (m * pow >= raw) return Math.max(1, m * pow);
  }
  return Math.max(1, 10 * pow);
}
