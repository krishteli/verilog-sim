import type { Span } from '../core';
import type { BoardSnapshot, BoardTopInfo, ButtonName } from '../core/board/basys3';

export type BoardRequest =
  | {
      type: 'start';
      source: string;
      /** Parameter overrides as typed by the user; empty strings mean "use the default". */
      params: Record<string, string>;
      /** Target clock rate in Hz; 0 = as fast as possible. */
      hz: number;
      /** Bit i set = switch i is up, so switch positions survive a restart. */
      switches: number;
    }
  | { type: 'switch'; index: number; on: boolean }
  | { type: 'button'; name: ButtonName; down: boolean }
  | { type: 'speed'; hz: number }
  | { type: 'pause'; paused: boolean };

export type BoardResponse =
  | { type: 'ready'; top: BoardTopInfo; used: string[]; unconnected: string[] }
  | { type: 'noBoardTop' }
  | { type: 'error'; message: string; span: Span | null }
  /** `rate` is the measured clock rate in cycles per second. */
  | { type: 'frame'; snapshot: BoardSnapshot; rate: number };
