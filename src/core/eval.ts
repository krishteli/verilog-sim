/**
 * Turn sized netlist expressions into JavaScript closures.
 *
 * Why closures instead of walking the tree on every evaluation? A tree walk
 * re-does the `switch (node.k)` dispatch and re-reads widths each time. Here
 * that work happens once, when the expression is compiled; evaluation is then
 * just calling nested functions that each do one operation. It's the same idea
 * as a "closure compiler" in interpreter design, and roughly a 2-5x speedup
 * over naive tree walking for little extra code.
 *
 * Every compiled function returns the canonical unsigned bit pattern of the
 * node's width (see bits.ts).
 */
import { mask, resize, toSigned, trunc } from './bits';
import type { NExpr } from './elab/netlist';

export interface EvalEnv {
  /** Current value of every signal, indexed by signal id. Mutated by the simulator. */
  values: bigint[];
  /** Width of every signal, indexed by id. */
  widths: number[];
  /** Current simulation time, for `$time`. */
  now: () => bigint;
}

export type Thunk = () => bigint;

/** Compile `child` and resize its result to the parent's width, extending with the parent's signedness. */
function operand(child: NExpr, width: number, signed: boolean, env: EvalEnv): Thunk {
  const f = compileExpr(child, env);
  if (child.width === width) return f;
  const from = child.width;
  return () => resize(f(), from, width, signed);
}

/** Bit offset of a select, from the signal's LSB. May be negative or past the end (reads then give 0s). */
export function compileOffset(index: NExpr | null, bias: number, scale: 1 | -1, env: EvalEnv): () => number {
  if (!index) return () => bias;
  const f = compileExpr(index, env);
  const w = index.width;
  const signed = index.signed;
  return () => {
    const raw = f();
    return bias + scale * Number(signed ? toSigned(raw, w) : raw);
  };
}

export function compileExpr(e: NExpr, env: EvalEnv): Thunk {
  const W = e.width;
  const values = env.values;

  switch (e.k) {
    case 'const': {
      const v = trunc(e.value, W);
      return () => v;
    }
    case 'sig': {
      const id = e.sig;
      return () => values[id]!;
    }
    case 'time':
      return () => trunc(env.now(), W);
    case 'cast': {
      // Same width: $signed/$unsigned, a pure reinterpretation. Wider: an
      // assignment widening, which extends according to the operand's sign.
      const f = compileExpr(e.a, env);
      if (e.a.width === W) return f;
      const from = e.a.width;
      const signed = e.a.signed;
      return () => resize(f(), from, W, signed);
    }

    case 'select': {
      const id = e.sig;
      const off = compileOffset(e.index, e.bias, e.scale, env);
      const m = mask(W);
      return () => {
        const o = off();
        const v = values[id]!;
        return (o >= 0 ? v >> BigInt(o) : v << BigInt(-o)) & m;
      };
    }

    case 'concat': {
      const parts = e.parts.map((p) => ({ f: compileExpr(p, env), w: BigInt(p.width) }));
      return () => {
        let acc = 0n;
        for (const p of parts) acc = (acc << p.w) | p.f();
        return acc;
      };
    }

    case 'cond': {
      const c = compileExpr(e.c, env);
      const t = operand(e.t, W, e.signed, env);
      const f = operand(e.e, W, e.signed, env);
      return () => (c() !== 0n ? t() : f());
    }

    case 'unary':
      return compileUnary(e, env);
    case 'binary':
      return compileBinary(e, env);
  }
}

function compileUnary(e: Extract<NExpr, { k: 'unary' }>, env: EvalEnv): Thunk {
  const W = e.width;
  const m = mask(W);
  // Reductions and `!` look at the operand at its own (self-determined) width.
  const self = compileExpr(e.a, env);
  const aw = e.a.width;
  const am = mask(aw);
  switch (e.op) {
    case '+':
      return operand(e.a, W, e.signed, env);
    case '-': {
      const a = operand(e.a, W, e.signed, env);
      return () => (-a()) & m;
    }
    case '~': {
      const a = operand(e.a, W, e.signed, env);
      return () => ~a() & m;
    }
    case '!':
      return () => (self() === 0n ? 1n : 0n);
    case '&':
      return () => (self() === am ? 1n : 0n);
    case '~&':
      return () => (self() === am ? 0n : 1n);
    case '|':
      return () => (self() !== 0n ? 1n : 0n);
    case '~|':
      return () => (self() !== 0n ? 0n : 1n);
    case '^':
      return () => parity(self());
    case '~^':
    case '^~':
      return () => parity(self()) ^ 1n;
  }
}

function parity(v: bigint): bigint {
  let p = 0n;
  while (v) {
    p ^= v & 1n;
    v >>= 1n;
  }
  return p;
}

function compileBinary(e: Extract<NExpr, { k: 'binary' }>, env: EvalEnv): Thunk {
  const W = e.width;
  const S = e.signed;
  const m = mask(W);
  const op = e.op;

  // Logical operators: each side is self-determined and just tested for non-zero.
  if (op === '&&' || op === '||') {
    const a = compileExpr(e.a, env);
    const b = compileExpr(e.b, env);
    return op === '&&' ? () => (a() !== 0n && b() !== 0n ? 1n : 0n) : () => (a() !== 0n || b() !== 0n ? 1n : 0n);
  }

  // Comparisons: both sides at a shared operand width; 1-bit result.
  if (['==', '!=', '===', '!==', '<', '<=', '>', '>='].includes(op)) {
    const ow = e.opWidth;
    const os = e.opSigned;
    const a0 = operand(e.a, ow, os, env);
    const b0 = operand(e.b, ow, os, env);
    const a = os ? () => toSigned(a0(), ow) : a0;
    const b = os ? () => toSigned(b0(), ow) : b0;
    switch (op) {
      case '==':
      case '===':
        return () => (a() === b() ? 1n : 0n);
      case '!=':
      case '!==':
        return () => (a() !== b() ? 1n : 0n);
      case '<':
        return () => (a() < b() ? 1n : 0n);
      case '<=':
        return () => (a() <= b() ? 1n : 0n);
      case '>':
        return () => (a() > b() ? 1n : 0n);
      default:
        return () => (a() >= b() ? 1n : 0n);
    }
  }

  // Shifts and power: the right operand is self-determined (its own width, treated as unsigned).
  if (op === '<<' || op === '<<<' || op === '>>' || op === '>>>' || op === '**') {
    const a = operand(e.a, W, S, env);
    const b = compileExpr(e.b, env);
    const bigW = BigInt(W);
    switch (op) {
      case '<<':
      case '<<<':
        return () => {
          const n = b();
          return n >= bigW ? 0n : (a() << n) & m;
        };
      case '>>':
        return () => a() >> b();
      case '>>>':
        // Arithmetic shift only if the expression is signed; otherwise it's a logical shift.
        return S ? () => trunc(toSigned(a(), W) >> b(), W) : () => a() >> b();
      default:
        return () => powMod(a(), b(), W);
    }
  }

  // Arithmetic and bitwise: both operands extended to the expression width.
  const a = operand(e.a, W, S, env);
  const b = operand(e.b, W, S, env);
  switch (op) {
    case '+':
      return () => (a() + b()) & m;
    case '-':
      return () => (a() - b()) & m;
    case '*':
      return () => (a() * b()) & m;
    case '/':
    case '%': {
      // 2-state: divide by zero gives 0 (4-state Verilog would give x).
      // BigInt division truncates toward zero, which is exactly Verilog's rule.
      const div = op === '/';
      if (S) {
        return () => {
          const x = toSigned(a(), W);
          const y = toSigned(b(), W);
          return y === 0n ? 0n : trunc(div ? x / y : x % y, W);
        };
      }
      return () => {
        const y = b();
        return y === 0n ? 0n : div ? a() / y : a() % y;
      };
    }
    case '&':
      return () => a() & b();
    case '|':
      return () => a() | b();
    case '^':
      return () => a() ^ b();
    case '~^':
    case '^~':
      return () => ~(a() ^ b()) & m;
    default:
      throw new Error(`unhandled binary operator ${op}`);
  }
}

/** base^exp mod 2^W by repeated squaring, so `2 ** 1000` doesn't build a 1000-bit number. */
function powMod(base: bigint, exp: bigint, width: number): bigint {
  const m = mask(width);
  let result = 1n & m;
  let b = base & m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) & m;
    b = (b * b) & m;
    e >>= 1n;
  }
  return result;
}
