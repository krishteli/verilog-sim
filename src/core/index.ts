/**
 * Public entry point of the core pipeline: source text in, simulation out.
 * The UI, the Web Worker and the golden tests all go through here.
 */
import { elaborate, type ElabOptions } from './elab/elaborate';
import type { Netlist } from './elab/netlist';
import { parse } from './parser/parser';
import { createSession, simulate, type SimOptions, type SimResult } from './sim/simulator';

export { VerilogError, type Span } from './diagnostics';
export type { ElabOptions } from './elab/elaborate';
export type { Netlist, Signal } from './elab/netlist';
export type { SimOptions, SimResult, SimSession, Wave } from './sim/simulator';
export { parse, elaborate, simulate, createSession };

export function compile(source: string, options?: ElabOptions): Netlist {
  return elaborate(parse(source), options);
}

export function run(source: string, options?: SimOptions): { netlist: Netlist; result: SimResult } {
  const netlist = compile(source);
  return { netlist, result: simulate(netlist, options) };
}
