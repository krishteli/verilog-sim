/**
 * Turn elaborated expressions back into readable Verilog-ish text for
 * schematic labels. The netlist has already folded parameters into
 * constants and resolved names to signal ids, so this is not the original
 * source text (that's what the click-to-source link is for), but it is the
 * logic the simulator actually runs.
 */
import type { NExpr, NLValue, Signal, Trigger } from '../elab/netlist';

/** A signal's name as seen from `scope`: `q` inside it, `dut.q` from a parent, full path otherwise. */
export function nameFrom(sig: Signal, scope: string): string {
  if (sig.scope === scope) return sig.local;
  if (sig.name.startsWith(scope + '.')) return sig.name.slice(scope.length + 1);
  return sig.name;
}

/** Declared index of bit offset `off` (offsets count from the LSB). */
function declIndex(sig: Signal, off: number): number {
  return sig.msb >= sig.lsb ? sig.lsb + off : sig.lsb - off;
}

function constText(value: bigint, width: number): string {
  if (width === 32) return value.toString(); // plain integer literal or folded parameter
  if (width === 1) return `1'b${value}`;
  return `${width}'d${value}`;
}

export function exprText(e: NExpr, signals: Signal[], scope: string, nested = false): string {
  const sub = (x: NExpr) => exprText(x, signals, scope, true);
  const wrap = (s: string) => (nested ? `(${s})` : s);
  switch (e.k) {
    case 'const':
      return constText(e.value, e.width);
    case 'sig':
      return nameFrom(signals[e.sig]!, scope);
    case 'select': {
      const sig = signals[e.sig]!;
      const name = nameFrom(sig, scope);
      if (e.index) {
        // Variable index: show the index expression (the bias/scale math is an implementation detail).
        const idx = exprText(e.index, signals, scope);
        return e.width === 1 ? `${name}[${idx}]` : `${name}[${idx} +: ${e.width}]`;
      }
      const lo = declIndex(sig, e.bias);
      const hi = declIndex(sig, e.bias + e.width - 1);
      return e.width === 1 ? `${name}[${lo}]` : `${name}[${hi}:${lo}]`;
    }
    case 'unary':
      return `${e.op}${sub(e.a)}`;
    case 'binary':
      return wrap(`${sub(e.a)} ${e.op} ${sub(e.b)}`);
    case 'cond':
      return wrap(`${sub(e.c)} ? ${sub(e.t)} : ${sub(e.e)}`);
    case 'concat':
      return `{${e.parts.map((p) => exprText(p, signals, scope)).join(', ')}}`;
    case 'time':
      return '$time';
    case 'cast':
      // Same width: $signed/$unsigned. Wider: an implicit assignment widening, not written by the user.
      return e.width === e.a.width ? `$${e.signed ? 'signed' : 'unsigned'}(${exprText(e.a, signals, scope)})` : exprText(e.a, signals, scope, nested);
  }
}

export function lvalueText(lv: NLValue, signals: Signal[], scope: string): string {
  switch (lv.k) {
    case 'sig':
      return nameFrom(signals[lv.sig]!, scope);
    case 'select':
      return exprText({ k: 'select', sig: lv.sig, index: lv.index, bias: lv.bias, scale: lv.scale, width: lv.width, signed: false }, signals, scope);
    case 'concat':
      return `{${lv.parts.map((p) => lvalueText(p, signals, scope)).join(', ')}}`;
  }
}

export function triggerText(t: Trigger, signals: Signal[], scope: string): string {
  if (t.k === 'star') return '@(*)';
  return `@(${t.items.map((it) => (it.edge ? `${it.edge} ` : '') + exprText(it.expr, signals, scope)).join(' or ')})`;
}
