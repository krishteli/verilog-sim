/**
 * A virtual Digilent Basys 3: drives a design's top-level ports the way the
 * real board does, and measures what its LEDs and 7-segment display show.
 *
 * Ports are matched **by name**, using the same names as the board's
 * constraints file (boards/basys3/basys3.xdc): `clk`, `sw`, `btnC`/`U`/`L`/
 * `R`/`D`, `led`, `seg`, `dp`, `an`. So a design that works here can go
 * straight to Vivado with that .xdc, and vice versa.
 *
 * Pure TypeScript (no DOM): it runs in the board Web Worker and under Vitest.
 */
import type { SourceFile } from '../parser/ast';
import type { Netlist, Signal } from '../elab/netlist';
import type { SimSession } from '../sim/simulator';

export const BUTTONS = ['btnU', 'btnL', 'btnC', 'btnR', 'btnD'] as const;
export type ButtonName = (typeof BUTTONS)[number];

const INPUTS = new Set<string>(['clk', 'sw', ...BUTTONS]);
const OUTPUTS = new Set<string>(['led', 'seg', 'dp', 'an']);

/**
 * Simulation time units per clock cycle. Time units are treated as
 * nanoseconds, so a 10-unit period is the board's 100 MHz oscillator and any
 * `#delay`s in the design keep their meaning relative to the clock.
 */
export const CLOCK_PERIOD = 10;

export interface BoardTopInfo {
  name: string;
  /** Overridable parameters with their default value as written in the source. */
  params: { name: string; defaultText: string }[];
}

/**
 * Pick the module to put on the board: the one with the most ports named like
 * Basys 3 pins. A file usually also holds a testbench, which has no ports at
 * all, so this finds the design under test without the user having to say.
 */
export function findBoardTop(file: SourceFile, source: string): BoardTopInfo | null {
  let best: { mod: SourceFile['modules'][number]; score: number } | null = null;
  for (const mod of file.modules) {
    const score = mod.ports.filter((p) => INPUTS.has(p.name) || OUTPUTS.has(p.name)).length;
    if (score > 0 && (!best || score > best.score)) best = { mod, score };
  }
  if (!best) return null;
  const mod = best.mod;
  // Same overridability rule as the elaborator: with a #(...) header, only those.
  const headerHasParams = mod.params.some((p) => !p.local);
  const decls = [...mod.params, ...(headerHasParams ? [] : mod.items.filter((i) => i.kind === 'ParamDecl'))];
  const params = decls
    .filter((d) => !d.local)
    .flatMap((d) => d.assignments.map((a) => ({ name: a.name, defaultText: source.slice(a.value.span.start, a.value.span.end) })));
  return { name: mod.name, params };
}

/** What the board shows, averaged over the cycles since the last snapshot. */
export interface BoardSnapshot {
  /** Brightness 0..1 of led[0]..led[15]. */
  leds: number[];
  /** digits[0] is the rightmost digit (an[0]); each holds brightness of segments a..g, then dp. */
  digits: number[][];
  /** Simulation time and clock cycles so far. */
  time: number;
  cycles: number;
  finished: boolean;
  output: string;
}

/** Bit `i` of a port, honouring its declared range (`[15:0]` vs `[0:15]`); -1 if out of range. */
function bitOffset(sig: Signal, i: number): number {
  const off = sig.msb >= sig.lsb ? i - sig.lsb : sig.lsb - i;
  return off >= 0 && off < sig.width ? off : -1;
}

export class Basys3 {
  private readonly ports = new Map<string, Signal>();
  /** Input ports of the design that aren't board pins; they stay 0. */
  readonly unconnected: string[] = [];
  /** Board pins the design actually uses, so the UI can grey out the rest. */
  readonly used = new Set<string>();

  private sw = 0;
  private readonly buttons = new Map<string, boolean>();
  private cycles = 0;

  // Accumulators since the last snapshot. Sampling every cycle (rather than
  // once per animation frame) is what makes multiplexed digits and PWM-dimmed
  // LEDs look right: we measure the fraction of time each light was on,
  // which is what your eye integrates on the real board.
  private sampled = 0;
  private readonly ledOn = new Array<number>(16).fill(0);
  private readonly digitActive = new Array<number>(4).fill(0);
  private readonly segOn = Array.from({ length: 4 }, () => new Array<number>(8).fill(0));
  /** Last measured look of each digit, kept while the design is lighting other digits. */
  private readonly latched = Array.from({ length: 4 }, () => new Array<number>(8).fill(0));

  constructor(
    private readonly session: SimSession,
    netlist: Netlist,
    top: string,
  ) {
    for (const s of netlist.signals) {
      if (s.scope !== top || !s.direction) continue;
      const known = s.direction === 'input' ? INPUTS.has(s.local) : OUTPUTS.has(s.local);
      if (known) {
        this.ports.set(s.local, s);
        this.used.add(s.local);
      } else if (s.direction === 'input') {
        this.unconnected.push(s.local);
      }
    }
    // Give every input a defined value at time 0 (switches down, buttons up).
    // Until then they are "unknown", like X on a real simulator.
    for (const name of ['clk', 'sw', ...BUTTONS]) {
      const s = this.ports.get(name);
      if (s) session.poke(s.id, 0n);
    }
    for (const s of netlist.signals) {
      if (s.scope === top && s.direction === 'input' && this.unconnected.includes(s.local)) session.poke(s.id, 0n);
    }
  }

  setSwitch(i: number, on: boolean): void {
    this.sw = on ? this.sw | (1 << i) : this.sw & ~(1 << i);
    const s = this.ports.get('sw');
    if (!s) return;
    let v = 0n;
    for (let b = 0; b < 16; b++) {
      const off = bitOffset(s, b);
      if (off >= 0 && this.sw & (1 << b)) v |= 1n << BigInt(off);
    }
    this.session.poke(s.id, v);
  }

  setButton(name: ButtonName, down: boolean): void {
    this.buttons.set(name, down);
    const s = this.ports.get(name);
    if (s) this.session.poke(s.id, down ? 1n : 0n);
  }

  /** Run `n` clock cycles (or until $finish), sampling the outputs after each. */
  runCycles(n: number): void {
    const clk = this.ports.get('clk');
    const half = CLOCK_PERIOD / 2;
    for (let c = 0; c < n && !this.session.finished; c++) {
      if (clk) this.session.poke(clk.id, 1n);
      this.session.advanceTo(this.session.time + half);
      if (clk) this.session.poke(clk.id, 0n);
      this.session.advanceTo(this.session.time + half);
      this.cycles++;
      this.sample();
    }
  }

  private read(name: string): number {
    const s = this.ports.get(name);
    return s ? Number(this.session.peek(s.id) & 0xffffn) : 0;
  }

  private sample(): void {
    this.sampled++;
    const led = this.ports.get('led');
    if (led) {
      const v = this.read('led');
      for (let i = 0; i < 16; i++) {
        const off = bitOffset(led, i);
        if (off >= 0 && (v >> off) & 1) this.ledOn[i]!++;
      }
    }
    const an = this.ports.get('an');
    if (!an) return;
    const anV = this.read('an');
    const seg = this.ports.get('seg');
    const segV = this.read('seg');
    const dpV = this.read('dp');
    for (let d = 0; d < 4; d++) {
      const off = bitOffset(an, d);
      // Anodes, segments and the decimal point are all active low on the Basys 3.
      if (off < 0 || (anV >> off) & 1) continue;
      this.digitActive[d]!++;
      const on = this.segOn[d]!;
      if (seg) {
        for (let k = 0; k < 7; k++) {
          const so = bitOffset(seg, k);
          if (so >= 0 && !((segV >> so) & 1)) on[k]!++;
        }
      }
      if (this.ports.has('dp') && !(dpV & 1)) on[7]!++;
    }
  }

  /** Brightness of everything since the last snapshot, then reset the counters. */
  snapshot(): BoardSnapshot {
    if (this.sampled === 0) this.sample(); // clock paused or very slow: show the current state
    const n = this.sampled;
    const leds = this.ledOn.map((c) => c / n);
    // No digit lit at all this frame: the display is off (blanked), not just scanning elsewhere.
    if (this.digitActive.every((a) => a === 0)) for (const l of this.latched) l.fill(0);
    for (let d = 0; d < 4; d++) {
      const active = this.digitActive[d]!;
      // Persistence of vision: a digit is shown as it looked while it was lit,
      // normalised by its own on-time, so a 4-way multiplexed display looks
      // as bright as a static one and doesn't flicker when the scan is slower
      // than our frame rate. A digit not lit at all this frame keeps its last look.
      if (active > 0) this.latched[d] = this.segOn[d]!.map((c) => c / active);
    }
    this.sampled = 0;
    this.ledOn.fill(0);
    this.digitActive.fill(0);
    for (const s of this.segOn) s.fill(0);
    return {
      leds,
      digits: this.latched.map((d) => [...d]),
      time: this.session.time,
      cycles: this.cycles,
      finished: this.session.finished,
      output: this.session.takeOutput(),
    };
  }
}
