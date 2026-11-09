/**
 * Runs the whole pipeline (parse -> elaborate -> simulate) off the main thread.
 *
 * Why a worker: a long simulation would otherwise freeze the page, since
 * JavaScript on the main thread can't paint while it computes. In a worker
 * the UI stays responsive, and a runaway design can be stopped by simply
 * terminating the worker (see simClient.ts).
 */
import { run, VerilogError } from '../core';
import type { SimRequest, SimResponse } from './simTypes';

self.onmessage = (event: MessageEvent<SimRequest>) => {
  const { id, source, maxTime } = event.data;
  const started = performance.now();
  let response: SimResponse;
  try {
    const { netlist, result } = run(source, { maxTime });
    response = { id, ok: true, netlist, result, ms: performance.now() - started };
  } catch (err) {
    if (err instanceof VerilogError) {
      response = { id, ok: false, message: err.message, span: err.span };
    } else {
      response = { id, ok: false, message: `internal error: ${(err as Error).message}`, span: null };
    }
  }
  self.postMessage(response);
};
