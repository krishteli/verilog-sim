import { resize, toSigned } from '../bits';
import { VerilogError, type Span } from '../diagnostics';
import { compileExpr, type EvalEnv } from '../eval';
import type * as A from '../parser/ast';
import type { ContAssign, InstanceInfo, NArg, Netlist, NExpr, NLValue, NStmt, Process, Signal, Trigger } from './netlist';

/**
 * Flatten a parsed design into a Netlist (see netlist.ts for what that means).
 *
 * Top-level modules are the ones nobody instantiates — usually the testbench.
 * Each is elaborated recursively: create the instance's signals, evaluate its
 * parameters, convert its statements, then elaborate child instances and
 * connect their ports.
 *
 * Port connections become ordinary continuous assignments
 * (`assign child.a = parent_expr;` for inputs, the reverse for outputs).
 * Real simulators often merge the two nets instead ("port collapsing"), which
 * is faster, but assignments are simpler, handle width mismatches for free,
 * and match how the Verilog standard defines port semantics.
 */
export function elaborate(file: A.SourceFile): Netlist {
  return new Elaborator(file).run();
}

/** Width cap for a single vector — protects the browser from `reg [1<<30:0] x;`. */
const MAX_WIDTH = 1 << 16;

/** Tasks that don't affect simulation results; accepted and ignored so common testbenches still run. */
const IGNORED_TASKS = new Set(['$dumpfile', '$dumpvars', '$dumpon', '$dumpoff', '$timeformat']);
const SUPPORTED_TASKS = new Set(['$display', '$write', '$strobe', '$monitor', '$finish', '$stop']);

type ScopeEntry =
  | { kind: 'sig'; id: number }
  | { kind: 'param'; value: bigint; width: number; signed: boolean; overridable: boolean };

interface Ctx {
  path: string;
  module: A.ModuleDecl;
  scope: Map<string, ScopeEntry>;
}

interface ParamValue {
  value: bigint;
  width: number;
  signed: boolean;
  span: Span;
}

interface Overrides {
  named: Map<string, ParamValue>;
  positional: ParamValue[];
  span: Span;
}

type AssignMode = { k: 'cont'; what: string } | { k: 'proc' };

const CONST_ENV: EvalEnv = { values: [], widths: [], now: () => 0n };

const COMPARE_OPS = new Set(['==', '!=', '===', '!==', '<', '<=', '>', '>=']);
const SHIFT_OPS = new Set(['<<', '>>', '<<<', '>>>', '**']);

class Elaborator {
  private readonly modules = new Map<string, A.ModuleDecl>();
  private readonly signals: Signal[] = [];
  private readonly assigns: ContAssign[] = [];
  private readonly processes: Process[] = [];
  private readonly instances: InstanceInfo[] = [];
  private readonly stack: string[] = [];
  /** Hierarchical name -> signal, for `dut.count` style references. */
  private readonly sigByName = new Map<string, Signal>();

  constructor(private readonly file: A.SourceFile) {}

  run(): Netlist {
    for (const m of this.file.modules) {
      if (this.modules.has(m.name)) throw new VerilogError(`module '${m.name}' is defined twice`, m.span);
      this.modules.set(m.name, m);
    }
    if (this.modules.size === 0) throw new VerilogError('no modules to simulate', this.file.span);

    const instantiated = new Set<string>();
    for (const m of this.file.modules) {
      for (const item of m.items) if (item.kind === 'Instance') instantiated.add(item.moduleName);
    }
    const tops = this.file.modules.filter((m) => !instantiated.has(m.name));
    if (tops.length === 0) {
      throw new VerilogError('every module is instantiated by another, so there is no top-level module', this.file.span);
    }

    for (const top of tops) {
      this.elabModule(top, top.name, null, { named: new Map(), positional: [], span: top.span });
    }
    return {
      signals: this.signals,
      assigns: this.assigns,
      processes: this.processes,
      instances: this.instances,
      tops: tops.map((t) => t.name),
    };
  }

  // ---- modules ----------------------------------------------------------------

  /** Elaborate one instance of `mod` at `path`; returns its scope so the parent can find port signals. */
  private elabModule(mod: A.ModuleDecl, path: string, parent: string | null, overrides: Overrides): Ctx {
    if (this.stack.includes(mod.name)) {
      throw new VerilogError(`module '${mod.name}' instantiates itself (recursively)`, overrides.span);
    }
    this.stack.push(mod.name);
    const ctx: Ctx = { path, module: mod, scope: new Map() };
    this.instances.push({ path, module: mod.name, parent, span: mod.span });

    // Parameters. If the header has a #(...) list, only those can be overridden
    // and body `parameter`s act like localparams (that's the standard's rule too).
    const headerHasParams = mod.params.some((p) => !p.local);
    const overridable: string[] = [];
    const declareParams = (decl: A.ParamDecl, inHeader: boolean) => {
      const canOverride = !decl.local && (inHeader || !headerHasParams);
      for (const a of decl.assignments) {
        const override = canOverride ? (overrides.named.get(a.name) ?? overrides.positional[overridable.length]) : undefined;
        if (canOverride) overridable.push(a.name);
        const v = override ?? this.evalConst(a.value, ctx);
        this.declareParam(ctx, decl, a, v);
      }
    };
    for (const p of mod.params) declareParams(p, true);

    // Ports.
    for (const port of mod.ports) {
      if (port.direction === 'inout') throw new VerilogError('inout ports are not supported yet', port.span);
      this.declareSignal(ctx, port.name, port.netType, port.range, port.signed, port.direction, port.span);
    }

    // Pass 1: declarations, so statements can refer to nets declared further down.
    for (const item of mod.items) {
      if (item.kind === 'ParamDecl') declareParams(item, false);
      if (item.kind === 'NetDecl') {
        for (const d of item.declarators) {
          const id = this.declareSignal(ctx, d.name, item.netType, item.range, item.signed, null, d.span);
          if (d.init && item.netType !== 'wire') {
            const sig = this.signals[id]!;
            const v = this.evalConst(d.init, ctx);
            sig.init = resize(v.value, v.width, sig.width, v.signed);
          }
        }
      }
    }

    for (const name of overrides.named.keys()) {
      if (!overridable.includes(name)) {
        throw new VerilogError(`module '${mod.name}' has no overridable parameter '${name}'`, overrides.named.get(name)!.span);
      }
    }
    if (overrides.positional.length > overridable.length) {
      throw new VerilogError(
        `too many parameter overrides for '${mod.name}' (it has ${overridable.length})`,
        overrides.positional[overridable.length]!.span,
      );
    }

    // Pass 2: child instances first, so hierarchical references like
    // `dut.count` in this module's statements can find the child's signals.
    for (const item of mod.items) if (item.kind === 'Instance') this.elabInstance(item, ctx);

    // Pass 3: behaviour.
    for (const item of mod.items) {
      switch (item.kind) {
        case 'NetDecl':
          for (const d of item.declarators) {
            if (d.init && item.netType === 'wire') {
              // `wire y = a & b;` is shorthand for a continuous assignment.
              this.addContAssign(ctx, { kind: 'Ident', name: d.name, span: d.span }, d.init, d.span, 'assign');
            }
          }
          break;
        case 'ContinuousAssign':
          for (const a of item.assignments) this.addContAssign(ctx, a.lhs, a.rhs, a.span, 'assign');
          break;
        case 'Always':
          this.processes.push(this.convertAlways(item, ctx));
          break;
        case 'Initial':
          this.processes.push({ kind: 'initial', comb: null, body: this.convertStmt(item.body, ctx), scope: path, span: item.span });
          break;
        case 'Instance':
        case 'ParamDecl':
          break;
      }
    }

    this.stack.pop();
    return ctx;
  }

  private declareParam(ctx: Ctx, decl: A.ParamDecl, a: A.ParamAssignment, v: ParamValue): void {
    if (ctx.scope.has(a.name)) throw new VerilogError(`'${a.name}' is already declared`, a.span);
    let { value, width, signed } = v;
    if (decl.range) {
      const r = this.evalRange(decl.range, ctx);
      value = resize(value, width, r.width, signed);
      width = r.width;
      signed = decl.signed;
    } else if (decl.signed) {
      signed = true;
    }
    ctx.scope.set(a.name, { kind: 'param', value, width, signed, overridable: !decl.local });
  }

  private declareSignal(
    ctx: Ctx,
    name: string,
    netType: A.NetType,
    range: A.Range | null,
    signed: boolean,
    direction: 'input' | 'output' | null,
    span: Span,
  ): number {
    if (ctx.scope.has(name)) throw new VerilogError(`'${name}' is already declared`, span);
    let msb = 0;
    let lsb = 0;
    if (netType === 'integer') {
      msb = 31;
      signed = true;
    } else if (range) {
      ({ msb, lsb } = this.evalRange(range, ctx));
    }
    const id = this.signals.length;
    this.signals.push({
      id,
      name: `${ctx.path}.${name}`,
      scope: ctx.path,
      local: name,
      kind: netType,
      width: Math.abs(msb - lsb) + 1,
      signed,
      msb,
      lsb,
      direction,
      init: null,
      span,
    });
    ctx.scope.set(name, { kind: 'sig', id });
    this.sigByName.set(this.signals[id]!.name, this.signals[id]!);
    return id;
  }

  private elabInstance(inst: A.Instance, ctx: Ctx): void {
    const child = this.modules.get(inst.moduleName);
    if (!child) throw new VerilogError(`unknown module '${inst.moduleName}'`, inst.span);
    const childPath = `${ctx.path}.${inst.instanceName}`;
    if (this.instances.some((i) => i.path === childPath) || ctx.scope.has(inst.instanceName)) {
      throw new VerilogError(`'${inst.instanceName}' is already declared`, inst.span);
    }

    const overrides: Overrides = { named: new Map(), positional: [], span: inst.span };
    for (const c of inst.paramOverrides) {
      if (c.kind === 'Named') {
        if (!c.expr) continue;
        overrides.named.set(c.name, { ...this.evalConst(c.expr, ctx), span: c.span });
      } else {
        overrides.positional.push({ ...this.evalConst(c.expr, ctx), span: c.span });
      }
    }

    const childCtx = this.elabModule(child, childPath, ctx.path, overrides);
    const ports = child.ports;

    inst.connections.forEach((conn, i) => {
      let port: A.PortDecl | undefined;
      if (conn.kind === 'Named') {
        port = ports.find((p) => p.name === conn.name);
        if (!port) throw new VerilogError(`module '${child.name}' has no port named '${conn.name}'`, conn.span);
        if (!conn.expr) return; // explicitly unconnected: .q()
      } else {
        port = ports[i];
        if (!port) throw new VerilogError(`too many port connections for '${child.name}' (it has ${ports.length})`, conn.span);
      }
      const expr = conn.expr!;
      const portSig = (childCtx.scope.get(port.name) as { kind: 'sig'; id: number }).id;
      const portRef: A.Expr = { kind: 'Ident', name: port.name, span: port.span };

      if (port.direction === 'input') {
        // child.port = <parent expression>
        const lhs: NLValue = { k: 'sig', sig: portSig };
        const rhs = this.resolve(expr, ctx);
        this.pushAssign(lhs, this.signals[portSig]!.width, rhs, 'port', childPath, conn.span);
      } else {
        // <parent lvalue> = child.port
        const what = `output port '${port.name}' of '${inst.instanceName}'`;
        const { lv, width } = this.resolveLValue(expr, ctx, { k: 'cont', what });
        const rhs = this.resolve(portRef, childCtx);
        this.pushAssign(lv, width, rhs, 'port', ctx.path, conn.span);
      }
    });
  }

  private addContAssign(ctx: Ctx, lhsAst: A.Expr, rhsAst: A.Expr, span: Span, origin: 'assign' | 'port'): void {
    const { lv, width } = this.resolveLValue(lhsAst, ctx, { k: 'cont', what: 'continuous assignment' });
    this.pushAssign(lv, width, this.resolve(rhsAst, ctx), origin, ctx.path, span);
  }

  private pushAssign(lhs: NLValue, lhsWidth: number, rhs: NExpr, origin: 'assign' | 'port', scope: string, span: Span): void {
    rhs = sizeForAssign(rhs, lhsWidth);
    const reads = new Set<number>();
    collectReads(rhs, reads);
    collectLValueReads(lhs, reads);
    this.assigns.push({ lhs, rhs, reads: [...reads], origin, scope, span });
  }

  // ---- processes ----------------------------------------------------------------

  private convertAlways(item: A.AlwaysBlock, ctx: Ctx): Process {
    const b = item.body;
    if (b.kind === 'EventControl' && b.sensitivity.kind === 'Star') {
      if (!b.body) throw new VerilogError('always @(*) needs a statement to run', item.span);
      const body = this.convertStmt(b.body, ctx);
      const reads = new Set<number>();
      collectStmtReads(body, reads);
      return { kind: 'always', comb: { sigs: [...reads] }, body, scope: ctx.path, span: item.span };
    }
    return { kind: 'always', comb: null, body: this.convertStmt(b, ctx), scope: ctx.path, span: item.span };
  }

  private convertStmt(s: A.Stmt, ctx: Ctx): NStmt {
    switch (s.kind) {
      case 'Block':
        return { k: 'block', stmts: s.stmts.map((x) => this.convertStmt(x, ctx)) };
      case 'Null':
        return { k: 'null' };
      case 'If':
        return {
          k: 'if',
          cond: finalize(this.resolve(s.cond, ctx)),
          then: this.convertStmt(s.then, ctx),
          else: s.else ? this.convertStmt(s.else, ctx) : null,
        };
      case 'Case': {
        const subject = this.resolve(s.subject, ctx);
        const items = s.items.map((it) => ({ labels: it.labels.map((l) => this.resolve(l, ctx)), body: this.convertStmt(it.body, ctx) }));
        const all = [subject, ...items.flatMap((it) => it.labels)];
        const cmpWidth = Math.max(...all.map((e) => e.width));
        const cmpSigned = all.every((e) => e.signed);
        for (const e of all) coerce(e, cmpWidth, cmpSigned);
        return { k: 'case', subject, items, default: s.default ? this.convertStmt(s.default, ctx) : null, cmpWidth, cmpSigned };
      }
      case 'ProceduralAssign': {
        const { lv, width } = this.resolveLValue(s.lhs, ctx, { k: 'proc' });
        const rhs = sizeForAssign(this.resolve(s.rhs, ctx), width);
        return { k: 'assign', blocking: s.blocking, lhs: lv, rhs, span: s.span };
      }
      case 'Delay':
        return { k: 'delay', amount: finalize(this.resolve(s.amount, ctx)), body: s.body ? this.convertStmt(s.body, ctx) : null };
      case 'EventControl': {
        const body = s.body ? this.convertStmt(s.body, ctx) : null;
        let trigger: Trigger;
        if (s.sensitivity.kind === 'Star') {
          const reads = new Set<number>();
          if (body) collectStmtReads(body, reads);
          trigger = { k: 'star', sigs: [...reads] };
        } else {
          trigger = {
            k: 'list',
            items: s.sensitivity.items.map((it) => {
              const expr = finalize(this.resolve(it.signal, ctx));
              const reads = new Set<number>();
              collectReads(expr, reads);
              if (reads.size === 0) throw new VerilogError('event control must depend on at least one signal', it.span);
              return { edge: it.edge, expr, sigs: [...reads] };
            }),
          };
        }
        return { k: 'wait', trigger, body };
      }
      case 'SystemTaskCall': {
        if (IGNORED_TASKS.has(s.name)) return { k: 'null' };
        if (!SUPPORTED_TASKS.has(s.name)) throw new VerilogError(`system task ${s.name} is not supported`, s.span);
        const args: NArg[] = s.args.map((a) =>
          a.kind === 'String' ? { k: 'str', value: a.value } : { k: 'expr', expr: finalize(this.resolve(a, ctx)) },
        );
        return { k: 'systask', name: s.name, args, scope: ctx.path, span: s.span };
      }
    }
  }

  // ---- expressions ----------------------------------------------------------------

  /**
   * Resolve names and compute each node's *self-determined* width and
   * signedness (the size it has on its own). Context-determined sizing is
   * applied afterwards by `coerce`, once the caller knows the context.
   */
  private resolve(e: A.Expr, ctx: Ctx, constOnly = false): NExpr {
    switch (e.kind) {
      case 'Ident': {
        if (e.name.includes('.')) {
          if (constOnly) throw new VerilogError(`'${e.name}' is a signal, but a constant is required here`, e.span);
          const sig = this.lookupHierarchical(e.name, ctx, e.span);
          return { k: 'sig', sig: sig.id, width: sig.width, signed: sig.signed };
        }
        const entry = ctx.scope.get(e.name);
        if (!entry) throw new VerilogError(`'${e.name}' is not declared`, e.span);
        if (entry.kind === 'param') return { k: 'const', value: entry.value, width: entry.width, signed: entry.signed };
        if (constOnly) throw new VerilogError(`'${e.name}' is a signal, but a constant is required here`, e.span);
        const sig = this.signals[entry.id]!;
        return { k: 'sig', sig: sig.id, width: sig.width, signed: sig.signed };
      }
      case 'Number': {
        const v = e.value;
        // Unsized literals are at least 32 bits (wider only if the value needs it).
        const width = v.width ?? Math.max(32, v.bits.toString(2).length);
        return { k: 'const', value: v.bits, width, signed: v.signed };
      }
      case 'String': {
        // A string in an expression is its bytes as a vector, first character in the top byte.
        let value = 0n;
        for (const ch of e.value) value = (value << 8n) | BigInt(ch.charCodeAt(0) & 0xff);
        return { k: 'const', value, width: Math.max(8, 8 * e.value.length), signed: false };
      }
      case 'Unary': {
        const a = this.resolve(e.operand, ctx, constOnly);
        if (e.op === '+' || e.op === '-' || e.op === '~') {
          return { k: 'unary', op: e.op, a, width: a.width, signed: a.signed };
        }
        return { k: 'unary', op: e.op, a: finalize(a), width: 1, signed: false };
      }
      case 'Binary': {
        const a = this.resolve(e.left, ctx, constOnly);
        const b = this.resolve(e.right, ctx, constOnly);
        if (e.op === '&&' || e.op === '||') {
          return { k: 'binary', op: e.op, a: finalize(a), b: finalize(b), width: 1, signed: false, opWidth: 1, opSigned: false };
        }
        if (COMPARE_OPS.has(e.op)) {
          const opWidth = Math.max(a.width, b.width);
          const opSigned = a.signed && b.signed;
          coerce(a, opWidth, opSigned);
          coerce(b, opWidth, opSigned);
          return { k: 'binary', op: e.op, a, b, width: 1, signed: false, opWidth, opSigned };
        }
        if (SHIFT_OPS.has(e.op)) {
          return { k: 'binary', op: e.op, a, b: finalize(b), width: a.width, signed: a.signed, opWidth: a.width, opSigned: a.signed };
        }
        const width = Math.max(a.width, b.width);
        const signed = a.signed && b.signed;
        return { k: 'binary', op: e.op, a, b, width, signed, opWidth: width, opSigned: signed };
      }
      case 'Ternary': {
        const c = finalize(this.resolve(e.cond, ctx, constOnly));
        const t = this.resolve(e.then, ctx, constOnly);
        const f = this.resolve(e.else, ctx, constOnly);
        return { k: 'cond', c, t, e: f, width: Math.max(t.width, f.width), signed: t.signed && f.signed };
      }
      case 'Index':
      case 'RangeSelect':
      case 'PartSelect': {
        if (constOnly) throw new VerilogError('bit selects are not allowed in constant expressions', e.span);
        const sel = this.resolveSelect(e, ctx);
        return { k: 'select', ...sel, signed: false };
      }
      case 'Concat': {
        const parts = e.parts.map((p) => finalize(this.resolve(p, ctx, constOnly)));
        return { k: 'concat', parts, width: sum(parts.map((p) => p.width)), signed: false };
      }
      case 'Replicate': {
        const count = Number(this.evalConst(e.count, ctx).value);
        if (count < 1) throw new VerilogError('replication count must be at least 1', e.count.span);
        const once = e.parts.map((p) => finalize(this.resolve(p, ctx, constOnly)));
        const parts = Array.from({ length: count }, () => once).flat();
        const width = sum(parts.map((p) => p.width));
        if (width > MAX_WIDTH) throw new VerilogError(`replication is ${width} bits wide; the limit is ${MAX_WIDTH}`, e.span);
        return { k: 'concat', parts, width, signed: false };
      }
      case 'SystemCall': {
        if (e.name === '$time' || e.name === '$stime' || e.name === '$realtime') {
          if (constOnly) throw new VerilogError(`${e.name} is not a constant`, e.span);
          return { k: 'time', width: e.name === '$stime' ? 32 : 64, signed: false };
        }
        if (e.name === '$signed' || e.name === '$unsigned') {
          if (e.args.length !== 1) throw new VerilogError(`${e.name} takes exactly one argument`, e.span);
          const a = finalize(this.resolve(e.args[0]!, ctx, constOnly));
          return { k: 'cast', a, width: a.width, signed: e.name === '$signed' };
        }
        throw new VerilogError(`system function ${e.name} is not supported`, e.span);
      }
    }
  }

  /**
   * Resolve `dut.count`: first relative to the current instance
   * (`tb.dut.count` when we're in `tb`), then as an absolute path.
   * Read-only for now — assigning through a hierarchical name is rejected.
   */
  private lookupHierarchical(name: string, ctx: Ctx, span: Span): Signal {
    const sig = this.sigByName.get(`${ctx.path}.${name}`) ?? this.sigByName.get(name);
    if (!sig) throw new VerilogError(`hierarchical name '${name}' does not match any signal`, span);
    return sig;
  }

  /** Translate a Verilog select into the `bias + scale * index` form used by the netlist. */
  private resolveSelect(
    e: A.Index | A.RangeSelect | A.PartSelect,
    ctx: Ctx,
  ): { sig: number; index: NExpr | null; bias: number; scale: 1 | -1; width: number } {
    if (e.target.kind !== 'Ident') throw new VerilogError('only named signals can be bit-selected', e.target.span);
    const entry = ctx.scope.get(e.target.name);
    if (!entry) throw new VerilogError(`'${e.target.name}' is not declared`, e.target.span);
    if (entry.kind === 'param') throw new VerilogError('selecting bits of a parameter is not supported yet', e.span);
    const sig = this.signals[entry.id]!;
    const desc = sig.msb >= sig.lsb;
    const { lsb } = sig;

    let index: NExpr | null = null;
    let bias: number;
    let scale: 1 | -1 = desc ? 1 : -1;
    let width: number;

    if (e.kind === 'RangeSelect') {
      const hi = this.evalInt(e.msb, ctx);
      const lo = this.evalInt(e.lsb, ctx);
      if (desc ? hi < lo : hi > lo) {
        throw new VerilogError(`part-select [${hi}:${lo}] is reversed for '${sig.local}' declared [${sig.msb}:${sig.lsb}]`, e.span);
      }
      width = Math.abs(hi - lo) + 1;
      bias = desc ? lo - lsb : lsb - lo;
    } else {
      const base = finalize(this.resolve(e.kind === 'Index' ? e.index : e.base, ctx));
      if (e.kind === 'Index') {
        width = 1;
        bias = desc ? -lsb : lsb;
      } else {
        width = this.evalInt(e.width, ctx);
        if (width < 1) throw new VerilogError('part-select width must be at least 1', e.width.span);
        if (desc) bias = e.dir === '+:' ? -lsb : -lsb - width + 1;
        else bias = e.dir === '+:' ? lsb - width + 1 : lsb;
      }
      if (base.k === 'const') {
        // Fold constant indices so a[3] costs no more than a plain signal read.
        const n = Number(base.signed ? toSigned(base.value, base.width) : base.value);
        bias += scale * n;
      } else {
        index = base;
      }
    }

    if (!index && (bias < 0 || bias + width > sig.width)) {
      throw new VerilogError(`select is out of range for '${sig.local}' declared [${sig.msb}:${sig.lsb}]`, e.span);
    }
    if (!index) scale = 1;
    return { sig: sig.id, index, bias, scale, width };
  }

  private resolveLValue(e: A.Expr, ctx: Ctx, mode: AssignMode): { lv: NLValue; width: number } {
    switch (e.kind) {
      case 'Ident':
      case 'Index':
      case 'RangeSelect':
      case 'PartSelect': {
        const name = e.kind === 'Ident' ? e.name : e.target.kind === 'Ident' ? e.target.name : null;
        if (name === null) throw new VerilogError('not a valid assignment target', e.span);
        if (name.includes('.')) {
          throw new VerilogError(`assigning through a hierarchical name ('${name}') is not supported`, e.span);
        }
        const entry = ctx.scope.get(name);
        if (!entry) throw new VerilogError(`'${name}' is not declared`, e.span);
        if (entry.kind === 'param') throw new VerilogError(`cannot assign to parameter '${name}'`, e.span);
        const sig = this.signals[entry.id]!;
        this.checkAssignable(sig, mode, e.span);
        if (e.kind === 'Ident') return { lv: { k: 'sig', sig: sig.id }, width: sig.width };
        const sel = this.resolveSelect(e, ctx);
        return { lv: { k: 'select', ...sel }, width: sel.width };
      }
      case 'Concat': {
        const parts = e.parts.map((p) => this.resolveLValue(p, ctx, mode));
        const width = sum(parts.map((p) => p.width));
        return { lv: { k: 'concat', parts: parts.map((p) => p.lv), width }, width };
      }
      default:
        throw new VerilogError('not a valid assignment target', e.span);
    }
  }

  /** The classic wire-vs-reg rules, with messages that say how to fix the code. */
  private checkAssignable(sig: Signal, mode: AssignMode, span: Span): void {
    if (sig.direction === 'input') throw new VerilogError(`cannot assign to input port '${sig.local}'`, span);
    if (mode.k === 'cont' && sig.kind !== 'wire') {
      throw new VerilogError(`${mode.what} drives '${sig.local}', which is a ${sig.kind}; declare it as a wire`, span);
    }
    if (mode.k === 'proc' && sig.kind === 'wire') {
      throw new VerilogError(
        `cannot assign to wire '${sig.local}' inside an always/initial block; declare it as reg`,
        span,
      );
    }
  }

  // ---- constants ------------------------------------------------------------------

  private evalConst(e: A.Expr, ctx: Ctx): ParamValue {
    const n = finalize(this.resolve(e, ctx, true));
    return { value: compileExpr(n, CONST_ENV)(), width: n.width, signed: n.signed, span: e.span };
  }

  private evalInt(e: A.Expr, ctx: Ctx): number {
    const v = this.evalConst(e, ctx);
    return Number(v.signed ? toSigned(v.value, v.width) : v.value);
  }

  private evalRange(r: A.Range, ctx: Ctx): { msb: number; lsb: number; width: number } {
    const msb = this.evalInt(r.msb, ctx);
    const lsb = this.evalInt(r.lsb, ctx);
    const width = Math.abs(msb - lsb) + 1;
    if (width > MAX_WIDTH) throw new VerilogError(`vector is ${width} bits wide; the limit is ${MAX_WIDTH}`, r.span);
    return { msb, lsb, width };
  }
}

// ---- expression sizing helpers ------------------------------------------------------

/**
 * Apply Verilog's context-determined sizing: push `width`/`signed` down
 * through operators whose operands take the size of their context
 * (arithmetic, bitwise, unary -, ~, and both arms of ?:). Operands that are
 * self-determined (comparison operands, shift amounts, concatenation parts,
 * reduction operands) were already finalized in `resolve` and are left alone.
 *
 * Example: in `wire [8:0] s = a + b;` with 8-bit a and b, the `+` is computed
 * at 9 bits, so the carry lands in s[8] instead of being lost.
 */
export function coerce(e: NExpr, width: number, signed: boolean): void {
  switch (e.k) {
    case 'unary':
      if (e.op === '+' || e.op === '-' || e.op === '~') {
        e.width = width;
        e.signed = signed;
        coerce(e.a, width, signed);
      }
      return;
    case 'binary':
      if (e.op === '&&' || e.op === '||' || COMPARE_OPS.has(e.op)) return;
      e.width = width;
      e.signed = signed;
      e.opWidth = width;
      e.opSigned = signed;
      coerce(e.a, width, signed);
      if (!SHIFT_OPS.has(e.op)) coerce(e.b, width, signed);
      return;
    case 'cond':
      e.width = width;
      e.signed = signed;
      coerce(e.t, width, signed);
      coerce(e.e, width, signed);
      return;
    default:
      return; // leaves keep their own width; the parent extends them when evaluating
  }
}

/**
 * Size the right-hand side of an assignment. The context width is the larger of
 * the two sides; if the result is still narrower than the target (a lone signal
 * or constant), wrap it in a widening cast so it is sign-extended when the
 * *right-hand side* is signed. The target's signedness never matters.
 */
function sizeForAssign(rhs: NExpr, lhsWidth: number): NExpr {
  coerce(rhs, Math.max(lhsWidth, rhs.width), rhs.signed);
  if (rhs.width >= lhsWidth) return rhs;
  return { k: 'cast', a: rhs, width: lhsWidth, signed: rhs.signed };
}

/** Size an expression that appears in a self-determined position (if condition, index, delay, ...). */
function finalize(e: NExpr): NExpr {
  coerce(e, e.width, e.signed);
  return e;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function collectReads(e: NExpr, out: Set<number>): void {
  switch (e.k) {
    case 'sig':
      out.add(e.sig);
      return;
    case 'select':
      out.add(e.sig);
      if (e.index) collectReads(e.index, out);
      return;
    case 'unary':
    case 'cast':
      collectReads(e.a, out);
      return;
    case 'binary':
      collectReads(e.a, out);
      collectReads(e.b, out);
      return;
    case 'cond':
      collectReads(e.c, out);
      collectReads(e.t, out);
      collectReads(e.e, out);
      return;
    case 'concat':
      for (const p of e.parts) collectReads(p, out);
      return;
    default:
      return;
  }
}

/** Signals read when *computing where* an lvalue writes (its select indices), not the target itself. */
function collectLValueReads(lv: NLValue, out: Set<number>): void {
  if (lv.k === 'select' && lv.index) collectReads(lv.index, out);
  if (lv.k === 'concat') for (const p of lv.parts) collectLValueReads(p, out);
}

/** Everything a statement reads — the implicit sensitivity list of `@(*)`. */
export function collectStmtReads(s: NStmt, out: Set<number>): void {
  switch (s.k) {
    case 'block':
      for (const x of s.stmts) collectStmtReads(x, out);
      return;
    case 'if':
      collectReads(s.cond, out);
      collectStmtReads(s.then, out);
      if (s.else) collectStmtReads(s.else, out);
      return;
    case 'case':
      collectReads(s.subject, out);
      for (const it of s.items) {
        for (const l of it.labels) collectReads(l, out);
        collectStmtReads(it.body, out);
      }
      if (s.default) collectStmtReads(s.default, out);
      return;
    case 'assign':
      collectReads(s.rhs, out);
      collectLValueReads(s.lhs, out);
      return;
    case 'delay':
    case 'wait':
      if (s.body) collectStmtReads(s.body, out);
      return;
    case 'systask':
      for (const a of s.args) if (a.k === 'expr') collectReads(a.expr, out);
      return;
    case 'null':
      return;
  }
}
