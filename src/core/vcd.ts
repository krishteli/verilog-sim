/**
 * Export simulation results as a VCD (Value Change Dump) file, the standard
 * waveform format defined in IEEE 1364. GTKWave, Surfer, and most commercial
 * viewers can open it, so users aren't locked into our viewer.
 *
 * Format in brief: a header declares each signal with a short identifier code
 * inside nested `$scope`s, then the body lists `#<time>` markers each followed
 * by the values that changed at that time (`1!` for a bit, `b1010 "` for a vector).
 */
import type { Netlist } from './elab/netlist';
import type { SimResult } from './sim/simulator';

export interface VcdOptions {
  /** Our delays are unitless; this only labels them for the viewer. */
  timescale?: string;
}

/** Identifier codes use the printable ASCII range '!'..'~' as base-94 digits. */
function idCode(n: number): string {
  let s = '';
  do {
    s += String.fromCharCode(33 + (n % 94));
    n = Math.floor(n / 94);
  } while (n > 0);
  return s;
}

function fmtValue(value: bigint, width: number, code: string): string {
  return width === 1 ? `${value}${code}` : `b${value.toString(2)} ${code}`;
}

export function toVcd(netlist: Netlist, result: SimResult, opts: VcdOptions = {}): string {
  const lines: string[] = [];
  lines.push('$version verilog-sim $end');
  lines.push(`$timescale ${opts.timescale ?? '1ns'} $end`);

  // Build the scope tree from the dotted signal names.
  interface Scope {
    children: Map<string, Scope>;
    vars: { id: number; name: string }[];
  }
  const root: Scope = { children: new Map(), vars: [] };
  for (const s of netlist.signals) {
    let node = root;
    for (const part of s.scope.split('.')) {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map(), vars: [] };
        node.children.set(part, child);
      }
      node = child;
    }
    node.vars.push({ id: s.id, name: s.local });
  }

  const emit = (name: string, scope: Scope) => {
    lines.push(`$scope module ${name} $end`);
    for (const v of scope.vars) {
      const s = netlist.signals[v.id]!;
      const type = s.kind === 'wire' ? 'wire' : s.kind === 'integer' ? 'integer' : 'reg';
      const range = s.width > 1 ? ` [${s.msb}:${s.lsb}]` : '';
      lines.push(`$var ${type} ${s.width} ${idCode(s.id)} ${v.name}${range} $end`);
    }
    for (const [childName, child] of scope.children) emit(childName, child);
    lines.push('$upscope $end');
  };
  for (const [name, scope] of root.children) emit(name, scope);
  lines.push('$enddefinitions $end');

  // Merge every signal's change list into one time-ordered stream.
  const changes = new Map<number, string[]>();
  netlist.signals.forEach((s, id) => {
    const w = result.waves[id]!;
    const code = idCode(id);
    w.times.forEach((t, i) => {
      if (t === 0) return; // initial values go in $dumpvars below
      let list = changes.get(t);
      if (!list) changes.set(t, (list = []));
      list.push(fmtValue(w.values[i]!, s.width, code));
    });
  });

  lines.push('#0');
  lines.push('$dumpvars');
  netlist.signals.forEach((s, id) => lines.push(fmtValue(result.waves[id]!.values[0]!, s.width, idCode(id))));
  lines.push('$end');

  for (const t of [...changes.keys()].sort((a, b) => a - b)) {
    lines.push(`#${t}`);
    lines.push(...changes.get(t)!);
  }
  if (result.endTime > 0 && !changes.has(result.endTime)) lines.push(`#${result.endTime}`);
  return lines.join('\n') + '\n';
}
