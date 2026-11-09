/**
 * Bit-vector helpers.
 *
 * Representation: a W-bit value is a non-negative bigint in [0, 2^W). Signed
 * values use the same bit pattern (two's complement) and are only converted
 * to a negative bigint at the moment an operation needs the signed meaning
 * (signed compare, divide, arithmetic shift, printing). Keeping one canonical
 * unsigned form means equality checks and storage never depend on signedness.
 *
 * JS BigInt's `&` treats negative numbers as infinite two's complement, so
 * `trunc(-1n, 4) === 15n` — exactly the wrap-around hardware does.
 */

export function mask(width: number): bigint {
  return (1n << BigInt(width)) - 1n;
}

/** Keep the low `width` bits. Also turns a negative bigint into its two's-complement pattern. */
export function trunc(value: bigint, width: number): bigint {
  return value & mask(width);
}

/** Interpret a `width`-bit pattern as a two's-complement signed number. */
export function toSigned(value: bigint, width: number): bigint {
  if (width === 0) return 0n;
  const sign = 1n << BigInt(width - 1);
  return value & sign ? value - (1n << BigInt(width)) : value;
}

/**
 * Resize a value from `from` bits to `to` bits. Growing pads with zeros, or
 * with copies of the sign bit when `signed` (sign extension); shrinking keeps
 * the low bits. This is the one place Verilog's "operands are extended to the
 * expression width" rule is implemented.
 */
export function resize(value: bigint, from: number, to: number, signed: boolean): bigint {
  if (to <= from) return trunc(value, to);
  return signed ? trunc(toSigned(value, from), to) : value;
}

export function bit(value: bigint, index: number): 0 | 1 {
  return (value >> BigInt(index)) & 1n ? 1 : 0;
}

/** Number of decimal digits needed for the largest value of this width, used by %d padding. */
export function decimalDigits(width: number, signed: boolean): number {
  if (width === 0) return 1;
  const max = signed ? 1n << BigInt(width - 1) : mask(width);
  return max.toString().length + (signed ? 1 : 0);
}
