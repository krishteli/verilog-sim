import type { Netlist, SimResult, Span } from '../core';

export interface SimRequest {
  id: number;
  source: string;
  maxTime: number;
}

export type SimResponse =
  | { id: number; ok: true; netlist: Netlist; result: SimResult; ms: number }
  | { id: number; ok: false; message: string; span: Span | null };
