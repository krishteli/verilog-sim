/**
 * Build a block diagram of one module instance from the netlist.
 *
 * The netlist is flat (every signal and process of the whole design in one
 * list), so to draw one level of the hierarchy we select everything whose
 * scope is that instance and connect it up:
 *
 *   - its input ports become nodes on the left, output ports on the right;
 *   - each `assign`, `always` and `initial` becomes a box whose left pins are
 *     the signals it reads and whose right pins are the signals it writes;
 *   - each child instance becomes a box with its module's ports as pins
 *     (its insides are a separate diagram you can drill into);
 *   - for every signal, a wire runs from each pin that drives it to each pin
 *     that reads it.
 *
 * This is an RTL view (like Vivado's "elaborated design" or Yosys `show`
 * before synthesis): blocks are behaviour, not gates. Layout is left to ELK
 * in the UI; this module only decides *what* to draw, and stays pure data so
 * it can be unit-tested.
 */
import type { Span } from '../diagnostics';
import type { Netlist, NLValue, NStmt, Signal } from '../elab/netlist';
import { collectStmtReads } from '../elab/elaborate';
import { exprText, lvalueText, nameFrom, triggerText } from './exprText';

export type SchNodeKind = 'input' | 'output' | 'assign' | 'comb' | 'seq' | 'initial' | 'instance' | 'expr';

export interface SchPort {
  id: string;
  name: string;
  dir: 'in' | 'out';
  width: number;
  /** Clock pins of edge-triggered blocks. */
  edge?: 'posedge' | 'negedge';
  /** A hierarchical reference into an instance (`dut.count`), not one of its ports. */
  probe?: boolean;
}

export interface SchNode {
  id: string;
  kind: SchNodeKind;
  /** Main label: a port name, `always @(posedge clk)`, `y = a & b`, or the instance name. */
  title: string;
  /** Secondary label, e.g. the module name of an instance. */
  subtitle?: string;
  ports: SchPort[];
  span: Span;
  /** For instances: the scope to open when drilling down. */
  instancePath?: string;
}

export interface SchEdge {
  id: string;
  /** Port ids. */
  from: string;
  to: string;
  signal: string;
  width: number;
}

export interface Schematic {
  scope: string;
  module: string;
  nodes: SchNode[];
  edges: SchEdge[];
}

/** Signals an lvalue writes (`{a, b[3:0]}` writes a and b). */
function lvalueSigs(lv: NLValue, out: Set<number>): void {
  if (lv.k === 'concat') for (const p of lv.parts) lvalueSigs(p, out);
  else out.add(lv.sig);
}

function collectWrites(s: NStmt, out: Set<number>): void {
  switch (s.k) {
    case 'block':
      for (const x of s.stmts) collectWrites(x, out);
      return;
    case 'if':
      collectWrites(s.then, out);
      if (s.else) collectWrites(s.else, out);
      return;
    case 'case':
      for (const it of s.items) collectWrites(it.body, out);
      if (s.default) collectWrites(s.default, out);
      return;
    case 'assign':
      lvalueSigs(s.lhs, out);
      return;
    case 'delay':
    case 'wait':
      if (s.body) collectWrites(s.body, out);
      return;
    default:
      return;
  }
}

/** All `@(...)` triggers in a statement, with the edge each signal is waited on (if any). */
function collectTriggers(s: NStmt, out: Map<number, 'posedge' | 'negedge' | null>): void {
  switch (s.k) {
    case 'block':
      for (const x of s.stmts) collectTriggers(x, out);
      return;
    case 'if':
      collectTriggers(s.then, out);
      if (s.else) collectTriggers(s.else, out);
      return;
    case 'case':
      for (const it of s.items) collectTriggers(it.body, out);
      if (s.default) collectTriggers(s.default, out);
      return;
    case 'wait':
      if (s.trigger.k === 'list') {
        for (const it of s.trigger.items) for (const id of it.sigs) if (!out.has(id) || it.edge) out.set(id, it.edge);
      }
      if (s.body) collectTriggers(s.body, out);
      return;
    case 'delay':
      if (s.body) collectTriggers(s.body, out);
      return;
    default:
      return;
  }
}

const truncate = (s: string, n = 48) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** The instance paths available to view, parents before children. */
export function schematicScopes(netlist: Netlist): { path: string; module: string; depth: number }[] {
  return netlist.instances.map((i) => ({ path: i.path, module: i.module, depth: i.path.split('.').length - 1 }));
}

export function buildSchematic(netlist: Netlist, scope: string): Schematic {
  const { signals } = netlist;
  const inst = netlist.instances.find((i) => i.path === scope);
  if (!inst) throw new Error(`no instance '${scope}'`);
  const children = netlist.instances.filter((i) => i.parent === scope);
  /** Which direct child (if any) a signal lives in, at any depth. */
  const childOf = (sig: Signal) => children.find((c) => sig.scope === c.path || sig.scope.startsWith(c.path + '.'));

  const nodes: SchNode[] = [];
  /** Wires from expression boxes to instance pins (they don't carry a named signal). */
  const edgesExtra: { from: string; to: string; signal: string; width: number }[] = [];
  const drivers = new Map<number, string[]>();
  const readers = new Map<number, string[]>();
  const add = (m: Map<number, string[]>, sig: number, port: string) => {
    const list = m.get(sig);
    if (!list) m.set(sig, [port]);
    else if (!list.includes(port)) list.push(port);
  };

  let nextNode = 0;
  const newNode = (kind: SchNodeKind, title: string, span: Span, extra: Partial<SchNode> = {}): SchNode => {
    const node: SchNode = { id: `n${nextNode++}`, kind, title, span, ports: [], ...extra };
    nodes.push(node);
    return node;
  };
  const addPort = (node: SchNode, name: string, dir: 'in' | 'out', width: number, extra: Partial<SchPort> = {}): string => {
    const id = `${node.id}.p${node.ports.length}`;
    node.ports.push({ id, name, dir, width, ...extra });
    return id;
  };

  /** Hook up a set of read signals to input pins of `node`, one pin per signal. */
  const readPins = (node: SchNode, reads: Iterable<number>, edges?: Map<number, 'posedge' | 'negedge' | null>) => {
    // Clock pins first, the way they are drawn on flip-flops.
    const ordered = [...reads].sort((a, b) => Number(!!edges?.get(b)) - Number(!!edges?.get(a)));
    for (const id of ordered) {
      const sig = signals[id]!;
      const edge = edges?.get(id) ?? undefined;
      add(readers, id, addPort(node, nameFrom(sig, scope), 'in', sig.width, edge ? { edge } : {}));
    }
  };
  const writePins = (node: SchNode, writes: Iterable<number>) => {
    for (const id of writes) add(drivers, id, addPort(node, nameFrom(signals[id]!, scope), 'out', signals[id]!.width));
  };

  // Module ports.
  for (const sig of signals) {
    if (sig.scope !== scope || !sig.direction) continue;
    const range = sig.width > 1 ? ` [${sig.msb}:${sig.lsb}]` : '';
    if (sig.direction === 'input') {
      const n = newNode('input', sig.local, sig.span, { subtitle: range.trim() || undefined });
      add(drivers, sig.id, addPort(n, sig.local, 'out', sig.width));
    } else {
      const n = newNode('output', sig.local, sig.span, { subtitle: range.trim() || undefined });
      add(readers, sig.id, addPort(n, sig.local, 'in', sig.width));
    }
  }

  // Child instances, with one pin per port of their module.
  const instNode = new Map<string, SchNode>();
  const pinOf = new Map<number, string>(); // child port signal -> pin
  for (const c of children) {
    const n = newNode('instance', c.path.slice(scope.length + 1), c.span, { subtitle: c.module, instancePath: c.path });
    instNode.set(c.path, n);
    for (const sig of signals) {
      if (sig.scope !== c.path || !sig.direction) continue;
      pinOf.set(sig.id, addPort(n, sig.local, sig.direction === 'input' ? 'in' : 'out', sig.width));
    }
  }

  // Continuous assignments, including the ones that implement port connections.
  for (const a of netlist.assigns) {
    if (a.origin === 'port') {
      if (a.lhs.k === 'sig' && pinOf.has(a.lhs.sig) && signals[a.lhs.sig]!.direction === 'input' && childOf(signals[a.lhs.sig]!)) {
        // Parent expression -> child input pin. A plain signal is wired straight to the pin;
        // anything else (a constant, `a & b`) gets a small expression box in between.
        const pin = pinOf.get(a.lhs.sig)!;
        if (a.rhs.k === 'sig' && signals[a.rhs.sig]!.scope === scope) {
          add(readers, a.rhs.sig, pin);
        } else {
          const n = newNode('expr', truncate(exprText(a.rhs, signals, scope)), a.span);
          readPins(n, a.reads);
          const out = addPort(n, '', 'out', signals[a.lhs.sig]!.width);
          edgesExtra.push({ from: out, to: pin, signal: n.title, width: signals[a.lhs.sig]!.width });
        }
        continue;
      }
      if (a.scope === scope && a.rhs.k === 'sig' && pinOf.has(a.rhs.sig)) {
        // Child output pin -> parent signal(s).
        const written = new Set<number>();
        lvalueSigs(a.lhs, written);
        for (const id of written) add(drivers, id, pinOf.get(a.rhs.sig)!);
        continue;
      }
      continue; // the other side of a connection: belongs to a different level's diagram
    }
    if (a.scope !== scope) continue;
    const written = new Set<number>();
    lvalueSigs(a.lhs, written);
    const n = newNode('assign', truncate(`${lvalueText(a.lhs, signals, scope)} = ${exprText(a.rhs, signals, scope)}`), a.span);
    readPins(n, a.reads);
    writePins(n, written);
  }

  // Processes.
  for (const p of netlist.processes) {
    if (p.scope !== scope) continue;
    const reads = new Set<number>();
    collectStmtReads(p.body, reads);
    const triggers = new Map<number, 'posedge' | 'negedge' | null>();
    collectTriggers(p.body, triggers);
    for (const id of triggers.keys()) reads.add(id);
    const writes = new Set<number>();
    collectWrites(p.body, writes);

    let kind: SchNodeKind;
    let title: string;
    if (p.kind === 'initial') {
      kind = 'initial';
      title = 'initial';
    } else if (p.comb) {
      kind = 'comb';
      title = 'always @(*)';
    } else {
      const head = p.body.k === 'wait' ? triggerText(p.body.trigger, signals, scope) : p.body.k === 'delay' ? `#${exprText(p.body.amount, signals, scope)}` : '';
      // Edge-triggered: registers. Level-sensitive list: logic. Only delays
      // (`always #5 clk = ~clk`): a timed testbench process, like `initial`.
      kind = [...triggers.values()].some((e) => e) ? 'seq' : triggers.size > 0 ? 'comb' : 'initial';
      title = truncate(`always ${head}`.trim());
    }
    const n = newNode(kind, title, p.span);
    readPins(n, reads, triggers);
    writePins(n, writes);
  }

  // Reads of signals inside a child instance that aren't its ports (testbench
  // probes like `dut.count`): give the instance an extra "probe" pin.
  for (const [id] of readers) {
    const sig = signals[id]!;
    if (sig.scope === scope || drivers.has(id) || pinOf.has(id)) continue;
    const c = childOf(sig);
    if (!c) continue;
    add(drivers, id, addPort(instNode.get(c.path)!, nameFrom(sig, c.path), 'out', sig.width, { probe: true }));
  }
  // A child output port read directly (via its pin) also counts as driven by that pin.
  for (const [id] of readers) if (pinOf.has(id) && !drivers.has(id)) add(drivers, id, pinOf.get(id)!);

  const edges: SchEdge[] = [];
  const seen = new Set<string>();
  const pushEdge = (from: string, to: string, signal: string, width: number) => {
    const key = `${from}>${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ id: `e${edges.length}`, from, to, signal, width });
  };
  for (const [id, outs] of drivers) {
    const ins = readers.get(id);
    if (!ins) continue;
    const sig = signals[id]!;
    for (const from of outs) for (const to of ins) pushEdge(from, to, nameFrom(sig, scope), sig.width);
  }
  for (const e of edgesExtra) pushEdge(e.from, e.to, e.signal, e.width);

  return { scope, module: inst.module, nodes, edges };
}
