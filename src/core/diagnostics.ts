/**
 * A region of source text.
 *
 * `start`/`end` are UTF-16 offsets into the source string (end exclusive), which
 * is what `String.prototype.slice` and Monaco's `getPositionAt` use.
 * `line`/`col` are 1-based and describe `start`; they are precomputed so error
 * messages don't have to rescan the source.
 */
export interface Span {
  start: number;
  end: number;
  line: number;
  col: number;
}

/**
 * The single error type thrown by every stage of the core pipeline.
 *
 * Carrying a Span (instead of only a message string) lets the UI put a red
 * squiggle in the right place in the editor, and lets tests assert on *where*
 * an error was reported, not just that one happened.
 */
export class VerilogError extends Error {
  readonly span: Span;

  constructor(message: string, span: Span) {
    super(`${span.line}:${span.col}: ${message}`);
    this.name = 'VerilogError';
    this.span = span;
  }
}
