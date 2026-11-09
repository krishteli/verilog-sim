import type { SimRequest, SimResponse } from './simTypes';

/**
 * Promise wrapper around the simulation worker.
 *
 * If a run is still going when a new one starts (or the user presses Stop),
 * the old worker is terminated and a fresh one created. Terminating is the
 * only reliable way to stop JavaScript that is stuck in a long loop.
 */
export class SimClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending: { id: number; resolve: (r: SimResponse | null) => void } | null = null;

  run(source: string, maxTime: number): Promise<SimResponse | null> {
    this.stop();
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending = { id, resolve };
      const req: SimRequest = { id, source, maxTime };
      worker.postMessage(req);
    });
  }

  /** Abort the current run, if any. Its promise resolves with null. */
  stop(): void {
    if (!this.pending) return;
    this.pending.resolve(null);
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<SimResponse>) => {
      if (this.pending?.id !== e.data.id) return;
      this.pending.resolve(e.data);
      this.pending = null;
    };
    w.onerror = (e) => {
      const p = this.pending;
      this.pending = null;
      p?.resolve({ id: p.id, ok: false, message: `worker crashed: ${e.message}`, span: null });
      this.worker = null;
    };
    this.worker = w;
    return w;
  }
}
