import { VerilogError, type Span } from '../diagnostics';
import { isKeyword, PUNCTUATORS, type NumberValue, type Punct, type Token } from './token';

/**
 * Turn Verilog source text into a flat list of tokens, ending with an `eof`
 * token. Throws a VerilogError at the first malformed token.
 *
 * Why a separate lexer instead of letting the parser read characters?
 * It keeps the parser focused on grammar. Whitespace, comments, number
 * formats like `8'b1010_0101` and maximal munch for `<<<` are all handled
 * here once, and the parser only ever sees clean tokens.
 *
 * Why lex everything up front instead of on demand? Verilog sources are
 * small (kilobytes), and an array lets the parser look ahead any number of
 * tokens with a plain index, which keeps backtracking-free decisions simple.
 */
export function tokenize(source: string): Token[] {
  return new Lexer(source).run();
}

/** Directives that don't affect a 2-state, single-file simulation; skipped whole-line. */
const IGNORED_DIRECTIVES = new Set(['timescale', 'default_nettype', 'resetall', 'celldefine', 'endcelldefine']);

const BASE_CHARS: Record<string, 2 | 8 | 10 | 16> = { b: 2, o: 8, d: 10, h: 16 };
const DIGITS_FOR_BASE: Record<2 | 8 | 10 | 16, RegExp> = {
  2: /^[01]+$/,
  8: /^[0-7]+$/,
  10: /^[0-9]+$/,
  16: /^[0-9a-fA-F]+$/,
};
const BIGINT_PREFIX: Record<2 | 8 | 16, string> = { 2: '0b', 8: '0o', 16: '0x' };

const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdentStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c) || c === '$';
const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

class Lexer {
  private pos = 0;
  private line = 1;
  private col = 1;
  private readonly tokens: Token[] = [];

  constructor(private readonly src: string) {}

  run(): Token[] {
    for (;;) {
      this.skipTrivia();
      if (this.pos >= this.src.length) break;
      this.lexToken();
    }
    this.tokens.push({ kind: 'eof', text: '', span: this.spanFrom(this.mark()) });
    return this.tokens;
  }

  // ---- position bookkeeping -------------------------------------------------

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? '';
  }

  /** Consume one character, keeping line/col in sync. */
  private advance(): string {
    const c = this.src[this.pos++]!;
    if (c === '\n') {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return c;
  }

  private mark(): Mark {
    return { pos: this.pos, line: this.line, col: this.col };
  }

  private reset(m: Mark): void {
    this.pos = m.pos;
    this.line = m.line;
    this.col = m.col;
  }

  private spanFrom(m: Mark): Span {
    return { start: m.pos, end: this.pos, line: m.line, col: m.col };
  }

  private error(message: string, m: Mark = this.mark()): never {
    const span = this.spanFrom(m);
    // Make zero-width error spans at least one character wide so editors can underline them.
    if (span.end === span.start && span.end < this.src.length) span.end++;
    throw new VerilogError(message, span);
  }

  // ---- trivia: whitespace, comments, ignored directives ---------------------

  private skipTrivia(): void {
    for (;;) {
      const c = this.peek();
      if (isSpace(c)) {
        this.advance();
      } else if (c === '/' && this.peek(1) === '/') {
        while (this.pos < this.src.length && this.peek() !== '\n') this.advance();
      } else if (c === '/' && this.peek(1) === '*') {
        const start = this.mark();
        this.advance();
        this.advance();
        while (!(this.peek() === '*' && this.peek(1) === '/')) {
          if (this.pos >= this.src.length) this.error('unterminated block comment', start);
          this.advance();
        }
        this.advance();
        this.advance();
      } else if (c === '`') {
        this.skipDirective();
      } else {
        return;
      }
    }
  }

  private skipDirective(): void {
    const start = this.mark();
    this.advance(); // the backtick
    let name = '';
    while (isIdentPart(this.peek())) name += this.advance();
    if (!IGNORED_DIRECTIVES.has(name)) {
      this.error(`compiler directive \`${name} is not supported yet`, start);
    }
    while (this.pos < this.src.length && this.peek() !== '\n') this.advance();
  }

  // ---- tokens ---------------------------------------------------------------

  private lexToken(): void {
    const start = this.mark();
    const c = this.peek();

    if (isIdentStart(c)) return this.lexIdentOrKeyword(start);
    if (c === '\\') return this.lexEscapedIdent(start);
    if (c === '$') return this.lexSystemIdent(start);
    if (isDigit(c)) return this.lexNumber(start);
    if (c === "'") return this.lexBasedNumber(start, null);
    if (c === '"') return this.lexString(start);
    this.lexPunct(start);
  }

  private lexIdentOrKeyword(start: Mark): void {
    while (isIdentPart(this.peek())) this.advance();
    const text = this.src.slice(start.pos, this.pos);
    const span = this.spanFrom(start);
    this.tokens.push(isKeyword(text) ? { kind: 'keyword', text, span } : { kind: 'ident', text, span });
  }

  /** `\bus[0] ` — an escaped identifier runs to the next whitespace; the backslash is not part of the name. */
  private lexEscapedIdent(start: Mark): void {
    this.advance();
    while (this.pos < this.src.length && !isSpace(this.peek())) this.advance();
    const text = this.src.slice(start.pos + 1, this.pos);
    if (text === '') this.error('empty escaped identifier', start);
    this.tokens.push({ kind: 'ident', text, span: this.spanFrom(start) });
  }

  private lexSystemIdent(start: Mark): void {
    this.advance();
    if (!isIdentStart(this.peek())) this.error("expected a system task name after '$'", start);
    while (isIdentPart(this.peek())) this.advance();
    this.tokens.push({ kind: 'systemIdent', text: this.src.slice(start.pos, this.pos), span: this.spanFrom(start) });
  }

  /**
   * A literal starting with a digit is either a plain decimal (`42`) or the
   * size of a based literal (`8'hFF`, and the standard even allows `8 'hFF`).
   * We read the digits, then peek past whitespace for a `'`; if there isn't
   * one we rewind and emit a plain decimal.
   */
  private lexNumber(start: Mark): void {
    while (isDigit(this.peek()) || this.peek() === '_') this.advance();
    const sizeText = this.src.slice(start.pos, this.pos).replace(/_/g, '');

    if (this.peek() === '.' && isDigit(this.peek(1))) {
      this.error('real numbers are not supported', start);
    }

    const afterDigits = this.mark();
    while (isSpace(this.peek())) this.advance();
    if (this.peek() === "'" && this.looksLikeBase(1)) {
      const width = Number(sizeText);
      if (width === 0) this.error('a sized literal must have a width of at least 1', start);
      return this.lexBasedNumber(start, width);
    }
    this.reset(afterDigits);

    // Unsized decimals are signed 32-bit integers in Verilog; we keep width null
    // and let the elaborator apply the 32-bit rule, since it owns width semantics.
    const value: NumberValue = { width: null, signed: true, base: 10, bits: BigInt(sizeText) };
    this.tokens.push({ kind: 'number', text: this.src.slice(start.pos, this.pos), span: this.spanFrom(start), value });
  }

  /** True if the text at `offset` past the current position is `[sS]?[bBoOdDhH]`. */
  private looksLikeBase(offset: number): boolean {
    let c = this.peek(offset).toLowerCase();
    if (c === 's') c = this.peek(offset + 1).toLowerCase();
    return c in BASE_CHARS;
  }

  /** Lex `'[s]<base><digits>`. `start` points at the size digits if there were any. */
  private lexBasedNumber(start: Mark, width: number | null): void {
    if (!this.looksLikeBase(1)) {
      this.advance();
      this.error("expected a base (b, o, d or h) after '", start);
    }
    this.advance(); // '
    let signed = false;
    if (this.peek().toLowerCase() === 's') {
      signed = true;
      this.advance();
    }
    const base = BASE_CHARS[this.advance().toLowerCase()]!;

    while (isSpace(this.peek())) this.advance();
    const digitsStart = this.mark();
    while (/[0-9a-zA-Z_?]/.test(this.peek())) this.advance();
    const raw = this.src.slice(digitsStart.pos, this.pos).replace(/_/g, '');

    if (raw === '') this.error('missing digits in based number', start);
    if (/[xXzZ?]/.test(raw)) {
      this.error('x/z values are not supported yet (the simulator is 2-state)', start);
    }
    if (!DIGITS_FOR_BASE[base].test(raw)) {
      this.error(`invalid digit for base ${base} in '${raw}'`, digitsStart);
    }

    let bits = base === 10 ? BigInt(raw) : BigInt(BIGINT_PREFIX[base] + raw);
    // Verilog truncates literals that don't fit their declared width (8'h1FF == 8'hFF).
    if (width !== null) bits &= (1n << BigInt(width)) - 1n;

    const value: NumberValue = { width, signed, base, bits };
    this.tokens.push({ kind: 'number', text: this.src.slice(start.pos, this.pos), span: this.spanFrom(start), value });
  }

  private lexString(start: Mark): void {
    this.advance(); // opening quote
    let value = '';
    for (;;) {
      const c = this.peek();
      if (c === '' || c === '\n') this.error('unterminated string literal', start);
      this.advance();
      if (c === '"') break;
      if (c === '\\') {
        const e = this.advance();
        value += e === 'n' ? '\n' : e === 't' ? '\t' : e; // \\ and \" fall through as themselves
      } else {
        value += c;
      }
    }
    this.tokens.push({ kind: 'string', text: this.src.slice(start.pos, this.pos), span: this.spanFrom(start), value });
  }

  private lexPunct(start: Mark): void {
    // PUNCTUATORS is sorted longest-first, so the first match is the longest one.
    const match = PUNCTUATORS.find((p) => this.src.startsWith(p, this.pos));
    if (!match) {
      this.advance();
      this.error(`unexpected character '${this.src[start.pos]}'`, start);
    }
    for (let i = 0; i < match.length; i++) this.advance();
    this.tokens.push({ kind: 'punct', text: match as Punct, span: this.spanFrom(start) });
  }
}

interface Mark {
  pos: number;
  line: number;
  col: number;
}
