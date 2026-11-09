/**
 * The elaborated design ("netlist"): what the simulator and schematic consume.
 *
 * Elaboration turns a *hierarchy* of module definitions into one *flat* list
 * of signals and processes. Every instance gets its own copy of its module's
 * signals, named by hierarchical path (`tb.dut.q`), and every name in every
 * expression is resolved to a signal id or folded into a constant. After this
 * step nothing downstream needs to know modules or scopes existed.
 *
 * Expressions are also fully *sized*: every node carries the width and
 * signedness it is evaluated at, following Verilog's expression-sizing rules.
 * Doing this once here keeps the simulator's inner loop free of type logic.
 *
 * Everything is plain data (no closures), so the netlist can be posted to a
 * Web Worker or rendered as a schematic.
 */
import type { Span } from '../diagnostics';
import type { BinaryOp, UnaryOp } from '../parser/ast';

export interface Signal {
  id: number;
  /** Hierarchical name, e.g. `tb.dut.count`. */
  name: string;
  /** Instance path that owns it, e.g. `tb.dut`. */
  scope: string;
  /** Name inside its module, e.g. `count`. */
  local: string;
  kind: 'wire' | 'reg' | 'integer';
  width: number;
  signed: boolean;
  /** Declared range, kept so bit selects can translate indices and the UI can show `[7:0]`. */
  msb: number;
  lsb: number;
  direction: 'input' | 'output' | null;
  /** Declaration initializer (`reg x = 1;`), applied at time 0; null if none. */
  init: bigint | null;
  span: Span;
}

interface Sized {
  width: number;
  signed: boolean;
}

export type NExpr = Sized &
  (
    | { k: 'const'; value: bigint }
    | { k: 'sig'; sig: number }
    /**
     * Bit or part select. The selected slice starts at bit offset
     * `bias + scale * index` from the signal's LSB (index omitted -> just `bias`).
     * This one formula covers `a[3]`, `a[7:4]`, `a[i +: 4]`, `a[i -: 4]` on both
     * `[7:0]` and `[0:7]` declarations; the elaborator computes bias/scale.
     */
    | { k: 'select'; sig: number; index: NExpr | null; bias: number; scale: 1 | -1 }
    | { k: 'unary'; op: UnaryOp; a: NExpr }
    /** For comparisons, operands are evaluated at `opWidth`/`opSigned` and the result is 1 bit. */
    | { k: 'binary'; op: BinaryOp; a: NExpr; b: NExpr; opWidth: number; opSigned: boolean }
    | { k: 'cond'; c: NExpr; t: NExpr; e: NExpr }
    | { k: 'concat'; parts: NExpr[] }
    | { k: 'time' }
    /**
     * `$signed(x)` / `$unsigned(x)` (same width, new signedness), or an
     * assignment widening (wider; extends using `a`'s own signedness).
     */
    | { k: 'cast'; a: NExpr }
  );

export type NLValue =
  | { k: 'sig'; sig: number }
  | { k: 'select'; sig: number; index: NExpr | null; bias: number; scale: 1 | -1; width: number }
  | { k: 'concat'; parts: NLValue[]; width: number };

export type NArg = { k: 'str'; value: string } | { k: 'expr'; expr: NExpr };

export type NStmt =
  | { k: 'block'; stmts: NStmt[] }
  | { k: 'if'; cond: NExpr; then: NStmt; else: NStmt | null }
  /** Subject and labels are all compared at `cmpWidth` bits (the widest of them), per the Verilog rule. */
  | {
      k: 'case';
      subject: NExpr;
      items: { labels: NExpr[]; body: NStmt }[];
      default: NStmt | null;
      cmpWidth: number;
      cmpSigned: boolean;
    }
  | { k: 'assign'; blocking: boolean; lhs: NLValue; rhs: NExpr; span: Span }
  | { k: 'delay'; amount: NExpr; body: NStmt | null }
  | { k: 'wait'; trigger: Trigger; body: NStmt | null }
  | { k: 'systask'; name: string; args: NArg[]; scope: string; span: Span }
  | { k: 'null' };

export type Trigger =
  | { k: 'star'; sigs: number[] }
  | { k: 'list'; items: { edge: 'posedge' | 'negedge' | null; expr: NExpr; sigs: number[] }[] };

/** A continuous assignment: `assign`, a net initializer, or a port connection. */
export interface ContAssign {
  lhs: NLValue;
  rhs: NExpr;
  /** Signals read by rhs (and by lhs select indices): when one changes, re-evaluate. */
  reads: number[];
  origin: 'assign' | 'port';
  scope: string;
  span: Span;
}

export interface Process {
  kind: 'initial' | 'always';
  /**
   * `always @(*)` blocks. They run once at time 0 and then on every input
   * change (SystemVerilog `always_comb` behaviour). Running once up front
   * matters in a 2-state simulator: there's no X->0 transition at startup
   * to wake them, so outputs would otherwise start out inconsistent.
   */
  comb: { sigs: number[] } | null;
  body: NStmt;
  scope: string;
  span: Span;
}

export interface InstanceInfo {
  path: string;
  module: string;
  parent: string | null;
  span: Span;
}

export interface Netlist {
  signals: Signal[];
  assigns: ContAssign[];
  processes: Process[];
  instances: InstanceInfo[];
  tops: string[];
}
