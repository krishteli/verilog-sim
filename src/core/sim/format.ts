/**
 * `$display`-style formatting, matching Icarus Verilog's output so the CI
 * comparison can diff the two byte for byte.
 *
 * The rule that surprises people: `%d` pads to the width of the *largest
 * possible value* of the argument (an 8-bit value prints in 3 columns, a
 * 32-bit integer in 10 plus a sign column), and `%b`/`%h` pad with zeros to
 * the full width. `%0d`, `%0b`, ... turn the padding off.
 */
import { decimalDigits, toSigned } from '../bits';

export type FmtArg =
  | { k: 'str'; value: string }
  | { k: 'val'; value: bigint; width: number; signed: boolean };

export class FormatError extends Error {}

/**
 * Format a `$display` argument list. Every string argument acts as a format
 * string that consumes the arguments after it; any value not consumed by a
 * format specifier is printed in default decimal format.
 */
export function formatArgs(args: FmtArg[], scope: string): string {
  let out = '';
  let i = 0;
  while (i < args.length) {
    const a = args[i++]!;
    if (a.k === 'val') {
      out += fmtDecimal(a, null);
      continue;
    }
    const fmt = a.value;
    for (let j = 0; j < fmt.length; j++) {
      const ch = fmt[j]!;
      if (ch !== '%') {
        out += ch;
        continue;
      }
      let widthText = '';
      while (j + 1 < fmt.length && /[0-9]/.test(fmt[j + 1]!)) widthText += fmt[++j];
      const spec = fmt[++j];
      if (spec === undefined) throw new FormatError("format string ends with a lone '%'");
      const minWidth = widthText === '' ? null : Number(widthText);
      const lower = spec.toLowerCase();

      if (spec === '%') {
        out += '%';
        continue;
      }
      if (lower === 'm') {
        out += scope;
        continue;
      }
      const arg = args[i++];
      if (!arg) throw new FormatError(`missing argument for '%${widthText}${spec}'`);

      switch (lower) {
        case 'd':
          out += arg.k === 'str' ? arg.value : fmtDecimal(arg, minWidth);
          break;
        case 't':
          // Icarus' default $timeformat pads %t to 20 columns.
          out += arg.k === 'str' ? arg.value : padStart(unsignedOrSigned(arg).toString(), minWidth ?? 20);
          break;
        case 'b':
        case 'o':
        case 'h':
        case 'x':
          out += arg.k === 'str' ? arg.value : fmtRadix(arg, lower === 'b' ? 2 : lower === 'o' ? 8 : 16, minWidth);
          break;
        case 'c':
          out += arg.k === 'str' ? arg.value.slice(0, 1) : String.fromCharCode(Number(arg.value & 0xffn));
          break;
        case 's':
          out += padStart(arg.k === 'str' ? arg.value : valueToString(arg.value), minWidth ?? 0);
          break;
        default:
          throw new FormatError(`unsupported format specifier '%${spec}'`);
      }
    }
  }
  return out;
}

function unsignedOrSigned(a: Extract<FmtArg, { k: 'val' }>): bigint {
  return a.signed ? toSigned(a.value, a.width) : a.value;
}

function fmtDecimal(a: Extract<FmtArg, { k: 'val' }>, minWidth: number | null): string {
  const text = unsignedOrSigned(a).toString();
  return padStart(text, minWidth ?? decimalDigits(a.width, a.signed));
}

function fmtRadix(a: Extract<FmtArg, { k: 'val' }>, radix: 2 | 8 | 16, minWidth: number | null): string {
  const text = a.value.toString(radix);
  const bitsPerDigit = radix === 2 ? 1 : radix === 8 ? 3 : 4;
  const full = Math.ceil(a.width / bitsPerDigit);
  return text.padStart(minWidth ?? full, '0');
}

function valueToString(v: bigint): string {
  let s = '';
  while (v > 0n) {
    const c = Number(v & 0xffn);
    if (c !== 0) s = String.fromCharCode(c) + s;
    v >>= 8n;
  }
  return s;
}

function padStart(s: string, width: number): string {
  return s.padStart(width, ' ');
}
