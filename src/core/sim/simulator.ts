/**
 * Event-driven simulator.
 *
 * The big idea: nothing is evaluated unless one of its inputs changed. Each
 * continuous assignment knows which signals it reads; each waiting process
 * knows which signals it's waiting on. When a signal changes, only those are
 * scheduled. A clocked design where most logic is idle each cycle does
 * proportionally little work.
 *
 * Each simulation time step is processed in "regions", a simplified version
 * of the Verilog standard's stratified event queue:
 *
 *   1. active    – run scheduled processes and continuous assignments.
 *                  Blocking `=` updates signals immediately, which may
 *                  schedule more work in this same region.
 *   2. inactive  – processes that did `#0`.
 *   3. NBA       – when nothing else is left, apply every pending
 *                  nonblocking `<=` update at once. That may wake more
 *                  logic, so we loop back to (1). Each loop is a "delta cycle".
 *   4. postponed – after the step settles: $strobe and $monitor output.
 *
 * Then time advances to the next scheduled `#delay`.
 *
 * Region 3 is why `a <= b; b <= a;` swaps two registers: both right-hand
 * sides are read in region 1, before either update is applied in region 3.
 *
 * Processes (`always`/`initial` blocks) are JavaScript generators. A process
 * runs until it hits `#10` or `@(posedge clk)`, `yield`s that request to the
 * scheduler, and is resumed exactly where it left off later. Generators give
 * us coroutines for free; without them we'd have to hand-build a stack of
 * "where was I inside this nested begin/if/case" for every process.
 */
import { bit, mask, resize, trunc } from '../bits';
import { VerilogError, type Span } from '../diagnostics';
import { collectReads } from '../elab/elaborate';
import type { NArg, Netlist, NLValue, NStmt, Signal } from '../elab/netlist';
import { compileExpr, compileOffset, type EvalEnv, type Thunk } from '../eval';
import { formatArgs, FormatError, type FmtArg } from './format';

export interface SimOptions {
  /** Stop when simulation time would pass this. */
  maxTime?: number;
  /** Max process/assignment evaluations within a single time step before we call it a combinational loop. */
  maxStepsPerTime?: number;
  /** Stop printing after this many output characters. */
  maxOutputChars?: number;
}

/** Value-change history of one signal: `values[i]` holds from `times[i]` until `times[i+1]`. */
export interface Wave {
  times: number[];
  values: bigint[];
}

export interface SimResult {
  output: string;
  endTime: number;
  stopReason: 'finish' | 'idle' | 'maxTime';
  /** Indexed by signal id. */
  waves: Wave[];
}

export function simulate(netlist: Netlist, options: SimOptions = {}): SimResult {
  return new Simulator(netlist, options).run();
}

// ---- internal types ----------------------------------------------------------------

interface Runnable {
  readonly span: Span;
  queued: boolean;
  run(): void;
}

/** A pending write of `width` bits at bit `off` of signal `sig`. */
interface Write {
  sig: number;
  off: number;
  width: number;
  value: bigint;
}

type Locate = (value: bigint) => Write[];

type Suspend = { k: 'delay'; t: number } | { k: 'wait'; trigger: CTrigger } | { k: 'finish' };

type CTrigger =
  | { k: 'star'; sigs: number[] }
  | { k: 'list'; items: { edge: 'posedge' | 'negedge' | null; f: Thunk; sigs: number[] }[] };

type CStmt =
  | { k: 'block'; stmts: CStmt[] }
  | { k: 'if'; cond: Thunk; then: CStmt; else: CStmt | null }
  | { k: 'case'; subject: Thunk; items: { labels: Thunk[]; body: CStmt }[]; default: CStmt | null }
  | { k: 'assign'; blocking: boolean; rhs: Thunk; locate: Locate }
  | { k: 'delay'; amount: Thunk; body: CStmt | null }
  | { k: 'wait'; trigger: CTrigger; body: CStmt | null }
  | { k: 'systask'; name: string; args: CArg[]; scope: string; span: Span }
  | { k: 'null' };

type CArg =
  | { k: 'str'; value: string }
  | { k: 'val'; f: Thunk; width: number; signed: boolean; isTime: boolean; reads: number[] };

interface Monitor {
  args: CArg[];
  /** Signals the arguments read; a change to any of them queues a check. */
  sigs: Set<number>;
  scope: string;
  span: Span;
  last: string | null;
  queued: boolean;
}

interface WaitState {
  trigger: CTrigger;
  /** Value of each list item when the wait started (for edge detection); null = still unknown (X). */
  last: (bigint | null)[];
}

class Proc implements Runnable {
  queued = false;
  done = false;
  suspends = 0;
  wait: WaitState | null = null;
  gen!: Generator<Suspend, void, undefined>;

  constructor(
    readonly span: Span,
    private readonly sim: Simulator,
  ) {}

  run(): void {
    this.sim.resume(this);
  }
}

class Simulator {
  private readonly signals: Signal[];
  private readonly values: bigint[];
  private readonly env: EvalEnv;
  private now = 0;

  private active: Runnable[] = [];
  private inactive: Proc[] = [];
  private nba: Write[] = [];
  /** time -> processes to resume then. `times` is kept sorted so the next time is `times[0]`. */
  private readonly future = new Map<number, Proc[]>();
  private readonly times: number[] = [];

  private readonly assignReaders: Runnable[][];
  private readonly waiters: Set<Proc>[];
  /**
   * True until a signal is first written. In 4-state Verilog it would hold X
   * until then; we store 0 but remember it's "unknown", so the first write
   * still counts as a change (X -> 0 wakes `@(sig)`, X -> 1 is a posedge),
   * the same events a 4-state simulator would produce.
   */
  private readonly unknown: boolean[];

  private readonly waves: Wave[];
  private out: string[] = [];
  private outChars = 0;
  private finished = false;
  /** Set by $finish; the simulation stops once the current time step completes. */
  private finishPending = false;
  /**
   * Postponed-region work ($strobe output, $monitor checks), run in the order
   * it was queued. That order is observable: Icarus prints whichever was
   * queued first, so we keep one FIFO rather than "all monitors, then strobes".
   */
  private postponedQueue: (() => void)[] = [];
  private monitor: Monitor | null = null;
  /** Whatever is running right now, for error messages. */
  private current: { span: Span } | null = null;

  private readonly maxTime: number;
  private readonly maxSteps: number;
  private readonly maxOutputChars: number;

  constructor(
    private readonly netlist: Netlist,
    opts: SimOptions,
  ) {
    this.maxTime = opts.maxTime ?? 100_000;
    this.maxSteps = opts.maxStepsPerTime ?? 1_000_000;
    this.maxOutputChars = opts.maxOutputChars ?? 1_000_000;

    this.signals = netlist.signals;
    this.values = this.signals.map(() => 0n);
    this.env = { values: this.values, widths: this.signals.map((s) => s.width), now: () => BigInt(this.now) };
    this.waves = this.signals.map(() => ({ times: [0], values: [0n] }));
    this.unknown = this.signals.map(() => true);
    this.assignReaders = this.signals.map(() => []);
    this.waiters = this.signals.map(() => new Set());
  }

  run(): SimResult {
    /*
     * Time-0 startup order, chosen to match Icarus (verified against it):
     *   1. `always` blocks start and arm their first wait;
     *   2. declaration initializers (`reg x = 5;`) are applied;
     *   3. every continuous assignment is evaluated once;
     *   4. `initial` blocks start — so they already see initialized values.
     */
    const procs = this.netlist.processes.map((p) => {
      const proc = new Proc(p.span, this);
      proc.gen = this.processBody(proc, p.kind, p.comb, this.compileStmt(p.body));
      return { proc, kind: p.kind };
    });
    for (const { proc, kind } of procs) if (kind === 'always') this.schedule(proc);

    for (const s of this.signals) {
      if (s.init === null) continue;
      const write: Write = { sig: s.id, off: 0, width: s.width, value: s.init };
      this.schedule({ queued: false, span: s.span, run: () => this.applyWrites([write], true) });
    }

    // Continuous assignments: compiled once, re-run whenever an input changes.
    for (const a of this.netlist.assigns) {
      const rhs = compileExpr(a.rhs, this.env);
      const locate = this.compileLValue(a.lhs);
      const runnable: Runnable = {
        queued: false,
        span: a.span,
        run: () => this.applyWrites(locate(rhs())),
      };
      for (const r of a.reads) this.assignReaders[r]!.push(runnable);
      this.schedule(runnable);
    }

    for (const { proc, kind } of procs) if (kind === 'initial') this.schedule(proc);

    let stopReason: SimResult['stopReason'] = 'idle';
    for (;;) {
      this.runTimeStep();
      if (this.finished) {
        stopReason = 'finish';
        break;
      }
      const next = this.times[0];
      if (next === undefined) break;
      if (next > this.maxTime) {
        stopReason = 'maxTime';
        this.now = this.maxTime;
        break;
      }
      this.times.shift();
      this.now = next;
      for (const p of this.future.get(next)!) this.schedule(p);
      this.future.delete(next);
    }

    return { output: this.out.join(''), endTime: this.now, stopReason, waves: this.waves };
  }

  /** Run regions 1-4 for the current time until nothing is left to do. */
  private runTimeStep(): void {
    let steps = 0;
    for (;;) {
      // Index loop instead of shift(): items appended during the loop are picked up too.
      for (let i = 0; i < this.active.length; i++) {
        const r = this.active[i]!;
        r.queued = false;
        this.current = r;
        r.run();
        if (++steps > this.maxSteps) {
          throw new VerilogError(
            `simulation did not settle at time ${this.now}; this is probably a combinational loop (logic that feeds back into itself without a register)`,
            this.current.span,
          );
        }
      }
      this.active = [];

      if (this.inactive.length) {
        for (const p of this.inactive) this.schedule(p);
        this.inactive = [];
        continue;
      }
      if (this.nba.length) {
        const updates = this.nba;
        this.nba = [];
        this.applyWrites(updates);
        continue;
      }
      break;
    }
    const work = this.postponedQueue;
    this.postponedQueue = [];
    for (const w of work) w();
    if (this.finishPending) this.finished = true;
  }

  /** Queue a $monitor check for the end of this time step (at most once per step). */
  private queueMonitor(): void {
    const m = this.monitor;
    if (!m || m.queued) return;
    m.queued = true;
    this.postponedQueue.push(() => {
      m.queued = false;
      if (this.monitor !== m) return; // replaced by a later $monitor call
      // $monitor prints when any argument other than $time changed.
      const key = m.args.map((a) => (a.k === 'val' && !a.isTime ? a.f().toString() : '')).join(',');
      if (key === m.last) return;
      m.last = key;
      this.print(this.format(m.args, m.scope, m.span) + '\n');
    });
  }

  private schedule(r: Runnable): void {
    if (r.queued) return;
    r.queued = true;
    this.active.push(r);
  }

  private scheduleAt(time: number, p: Proc): void {
    let list = this.future.get(time);
    if (!list) {
      list = [];
      this.future.set(time, list);
      // Binary search insert keeps `times` sorted.
      let lo = 0;
      let hi = this.times.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.times[mid]! < time) lo = mid + 1;
        else hi = mid;
      }
      this.times.splice(lo, 0, time);
    }
    list.push(p);
  }

  // ---- processes --------------------------------------------------------------------

  private *processBody(proc: Proc, kind: 'initial' | 'always', comb: { sigs: number[] } | null, body: CStmt): Generator<Suspend, void, undefined> {
    if (kind === 'initial') {
      yield* this.exec(body);
      return;
    }
    if (comb) {
      const trigger: CTrigger = { k: 'star', sigs: comb.sigs };
      for (;;) {
        yield* this.exec(body);
        yield { k: 'wait', trigger };
      }
    }
    for (;;) {
      const before = proc.suspends;
      yield* this.exec(body);
      if (proc.suspends === before) {
        throw new VerilogError('this always block has no delay or event control, so it would loop forever at time 0', proc.span);
      }
    }
  }

  /** Called by the scheduler: run `p` until its next `yield`, then park it accordingly. */
  resume(p: Proc): void {
    if (p.done) return;
    const r = p.gen.next();
    if (r.done) {
      p.done = true;
      return;
    }
    p.suspends++;
    const s = r.value;
    if (s.k === 'finish') {
      // Like Icarus, $finish ends the calling process at once, but the rest of
      // the current time step (other processes, NBA updates, $strobe/$monitor)
      // still completes before the simulation stops.
      p.done = true;
      this.finishPending = true;
    } else if (s.k === 'delay') {
      if (s.t === 0) this.inactive.push(p);
      else this.scheduleAt(this.now + s.t, p);
    } else {
      const last =
        s.trigger.k === 'list'
          ? s.trigger.items.map((it) => (it.sigs.some((id) => this.unknown[id]) ? null : it.f()))
          : [];
      p.wait = { trigger: s.trigger, last };
      const sigs = s.trigger.k === 'star' ? s.trigger.sigs : s.trigger.items.flatMap((it) => it.sigs);
      for (const id of sigs) this.waiters[id]!.add(p);
    }
  }

  private *exec(s: CStmt): Generator<Suspend, void, undefined> {
    switch (s.k) {
      case 'block':
        for (const x of s.stmts) yield* this.exec(x);
        return;
      case 'if':
        if (s.cond() !== 0n) yield* this.exec(s.then);
        else if (s.else) yield* this.exec(s.else);
        return;
      case 'case': {
        const v = s.subject();
        for (const item of s.items) {
          if (item.labels.some((l) => l() === v)) {
            yield* this.exec(item.body);
            return;
          }
        }
        if (s.default) yield* this.exec(s.default);
        return;
      }
      case 'assign': {
        // Both forms evaluate the right side *and* the target location now;
        // only the moment the write happens differs.
        const writes = s.locate(s.rhs());
        if (s.blocking) this.applyWrites(writes);
        else this.nba.push(...writes);
        return;
      }
      case 'delay': {
        const t = Number(s.amount());
        yield { k: 'delay', t };
        if (s.body) yield* this.exec(s.body);
        return;
      }
      case 'wait':
        yield { k: 'wait', trigger: s.trigger };
        if (s.body) yield* this.exec(s.body);
        return;
      case 'systask':
        if (this.systask(s)) yield { k: 'finish' };
        return;
      case 'null':
        return;
    }
  }

  /** Returns true if simulation should stop. */
  private systask(s: Extract<CStmt, { k: 'systask' }>): boolean {
    switch (s.name) {
      case '$display':
        this.print(this.format(s.args, s.scope, s.span) + '\n');
        return false;
      case '$write':
        this.print(this.format(s.args, s.scope, s.span));
        return false;
      case '$strobe':
        this.postponedQueue.push(() => this.print(this.format(s.args, s.scope, s.span) + '\n'));
        return false;
      case '$monitor': {
        const sigs = new Set(s.args.flatMap((a) => (a.k === 'val' ? a.reads : [])));
        this.monitor = { args: s.args, sigs, scope: s.scope, span: s.span, last: null, queued: false };
        this.queueMonitor(); // $monitor always prints once, at the end of the step it was called in
        return false;
      }
      case '$finish':
      case '$stop':
        return true;
      default:
        throw new VerilogError(`system task ${s.name} is not supported`, s.span);
    }
  }

  private format(args: CArg[], scope: string, span: Span): string {
    const values: FmtArg[] = args.map((a) => (a.k === 'str' ? a : { k: 'val', value: a.f(), width: a.width, signed: a.signed }));
    try {
      return formatArgs(values, scope);
    } catch (e) {
      if (e instanceof FormatError) throw new VerilogError(e.message, span);
      throw e;
    }
  }

  private print(text: string): void {
    if (this.outChars >= this.maxOutputChars) return;
    this.outChars += text.length;
    this.out.push(text);
    if (this.outChars >= this.maxOutputChars) this.out.push('\n[output truncated]\n');
  }

  // ---- signal updates -----------------------------------------------------------------

  private applyWrites(writes: Write[], isInit = false): void {
    for (const w of writes) {
      const width = this.signals[w.sig]!.width;
      let { off, width: ww, value } = w;
      if (off < 0) {
        // Partially below bit 0: drop the bits that fall off the end.
        value >>= BigInt(-off);
        ww += off;
        off = 0;
      }
      if (ww <= 0 || off >= width) continue;
      const old = this.values[w.sig]!;
      const m = mask(ww) << BigInt(off);
      const next = trunc((old & ~m) | ((value << BigInt(off)) & m), width);
      this.setSignal(w.sig, next, isInit);
    }
  }

  /**
   * `isInit` marks a declaration initializer: like Icarus, it wakes
   * level-sensitive waits (`@(x)`) but is not treated as an edge.
   */
  private setSignal(id: number, v: bigint, isInit = false): void {
    const wasUnknown = this.unknown[id]!;
    // No change -> no event: the heart of event-driven simulation.
    // (The first write to an unknown signal is a change from X, even if the value is 0.)
    if (!wasUnknown && this.values[id] === v) return;
    this.unknown[id] = false;
    this.values[id] = v;
    this.record(id, v);
    if (this.monitor?.sigs.has(id)) this.queueMonitor();
    for (const r of this.assignReaders[id]!) this.schedule(r);
    const waiting = this.waiters[id]!;
    if (waiting.size) for (const p of [...waiting]) this.checkWaiter(p, isInit);
  }

  private checkWaiter(p: Proc, isInit: boolean): void {
    const w = p.wait;
    if (!w) return;
    let fire = false;
    if (w.trigger.k === 'star') {
      fire = true;
    } else {
      w.trigger.items.forEach((it, i) => {
        if (it.sigs.some((id) => this.unknown[id])) return; // still partly X: no defined value yet
        const before = w.last[i]!;
        const after = it.f();
        if (before === after) return;
        w.last[i] = after;
        if (it.edge === null) {
          fire = true;
          return;
        }
        if (isInit) return;
        // Edges look at bit 0 only, like Verilog does for vectors. From X (before
        // === null), a 1 counts as a posedge and a 0 as a negedge.
        const b = before === null ? null : bit(before, 0);
        const a = bit(after, 0);
        if (it.edge === 'posedge' && a === 1 && b !== 1) fire = true;
        if (it.edge === 'negedge' && a === 0 && b !== 0) fire = true;
      });
    }
    if (!fire) return;
    const sigs = w.trigger.k === 'star' ? w.trigger.sigs : w.trigger.items.flatMap((it) => it.sigs);
    for (const id of sigs) this.waiters[id]!.delete(p);
    p.wait = null;
    this.schedule(p);
  }

  private record(id: number, v: bigint): void {
    const w = this.waves[id]!;
    const n = w.times.length;
    if (w.times[n - 1] === this.now) {
      // Several changes in one time step (delta cycles): keep only the final value.
      w.values[n - 1] = v;
      if (n > 1 && w.values[n - 2] === v) {
        w.times.pop();
        w.values.pop();
      }
    } else {
      w.times.push(this.now);
      w.values.push(v);
    }
  }

  // ---- compilation ------------------------------------------------------------------

  private compileLValue(lv: NLValue): Locate {
    switch (lv.k) {
      case 'sig': {
        const sig = lv.sig;
        const width = this.signals[sig]!.width;
        return (value) => [{ sig, off: 0, width, value: trunc(value, width) }];
      }
      case 'select': {
        const sig = lv.sig;
        const width = lv.width;
        const off = compileOffset(lv.index, lv.bias, lv.scale, this.env);
        return (value) => [{ sig, off: off(), width, value: trunc(value, width) }];
      }
      case 'concat': {
        // `{a, b} = v`: a gets the high bits, b the low bits.
        const parts = lv.parts.map((p) => ({ locate: this.compileLValue(p), width: lvWidth(p, this.signals) }));
        return (value) => {
          let shift = lv.width;
          const writes: Write[] = [];
          for (const p of parts) {
            shift -= p.width;
            writes.push(...p.locate(trunc(value >> BigInt(shift), p.width)));
          }
          return writes;
        };
      }
    }
  }

  private compileStmt(s: NStmt): CStmt {
    switch (s.k) {
      case 'block':
        return { k: 'block', stmts: s.stmts.map((x) => this.compileStmt(x)) };
      case 'if':
        return { k: 'if', cond: compileExpr(s.cond, this.env), then: this.compileStmt(s.then), else: s.else ? this.compileStmt(s.else) : null };
      case 'case': {
        const at = (e: typeof s.subject): Thunk => {
          const f = compileExpr(e, this.env);
          const from = e.width;
          return from === s.cmpWidth ? f : () => resize(f(), from, s.cmpWidth, s.cmpSigned);
        };
        return {
          k: 'case',
          subject: at(s.subject),
          items: s.items.map((it) => ({ labels: it.labels.map(at), body: this.compileStmt(it.body) })),
          default: s.default ? this.compileStmt(s.default) : null,
        };
      }
      case 'assign':
        return { k: 'assign', blocking: s.blocking, rhs: compileExpr(s.rhs, this.env), locate: this.compileLValue(s.lhs) };
      case 'delay':
        return { k: 'delay', amount: compileExpr(s.amount, this.env), body: s.body ? this.compileStmt(s.body) : null };
      case 'wait':
        return {
          k: 'wait',
          trigger:
            s.trigger.k === 'star'
              ? s.trigger
              : { k: 'list', items: s.trigger.items.map((it) => ({ edge: it.edge, f: compileExpr(it.expr, this.env), sigs: it.sigs })) },
          body: s.body ? this.compileStmt(s.body) : null,
        };
      case 'systask':
        return { k: 'systask', name: s.name, args: s.args.map((a) => this.compileArg(a)), scope: s.scope, span: s.span };
      case 'null':
        return { k: 'null' };
    }
  }

  private compileArg(a: NArg): CArg {
    if (a.k === 'str') return a;
    const reads = new Set<number>();
    collectReads(a.expr, reads);
    return {
      k: 'val',
      f: compileExpr(a.expr, this.env),
      width: a.expr.width,
      signed: a.expr.signed,
      isTime: a.expr.k === 'time',
      reads: [...reads],
    };
  }
}

function lvWidth(lv: NLValue, signals: Signal[]): number {
  return lv.k === 'sig' ? signals[lv.sig]!.width : lv.width;
}
