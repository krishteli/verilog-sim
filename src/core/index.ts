/**
 * Public entry point of the core pipeline: source text in, simulation out.
 * The UI, the Web Worker and the golden tests all go through here.
 */
import { elaborate } from './elab/elaborate';
import type { Netlist } from './elab/netlist';
import { parse } from './parser/parser';
import { simulate, type SimOptions, type SimResult } from './sim/simulator';

export { VerilogError, type Span } from './diagnostics';
export type { Netlist, Signal } from './elab/netlist';
export type { SimOptions, SimResult, Wave } from './sim/simulator';
export { parse, elaborate, simulate };

export function compile(source: string): Netlist {
  return elaborate(parse(source));
}

export function run(source: string, options?: SimOptions): { netlist: Netlist; result: SimResult } {
  const netlist = compile(source);
  return { netlist, result: simulate(netlist, options) };
}
