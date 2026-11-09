import type { Span } from '../diagnostics';

/**
 * Reserved words. This includes keywords we don't support yet (for, function,
 * generate, ...) so that they can never be mistaken for identifiers: the parser
 * can then say "'for' is not supported yet" instead of a confusing error about
 * an unknown module called `for`.
 */
export const KEYWORDS = [
  'module', 'endmodule',
  'input', 'output', 'inout',
  'wire', 'reg', 'integer', 'signed',
  'parameter', 'localparam',
  'assign', 'always', 'initial',
  'begin', 'end',
  'if', 'else',
  'case', 'casez', 'casex', 'endcase', 'default',
  'posedge', 'negedge', 'or',
  // Reserved but not in the v1 subset:
  'for', 'while', 'repeat', 'forever',
  'function', 'endfunction', 'task', 'endtask',
  'generate', 'endgenerate', 'genvar',
  'tri', 'supply0', 'supply1', 'real', 'time',
] as const;

export type Keyword = (typeof KEYWORDS)[number];

const KEYWORD_SET: ReadonlySet<string> = new Set(KEYWORDS);
export function isKeyword(text: string): text is Keyword {
  return KEYWORD_SET.has(text);
}

/**
 * Operators and punctuation, ordered longest first. The lexer uses "maximal
 * munch": at each position it takes the longest entry that matches, so `<<<`
 * wins over `<<`, which wins over `<`.
 *
 * Note `(*` is deliberately absent. In full Verilog it opens an attribute, but
 * we need `@(*)` to lex as `(` `*` `)`.
 */
export const PUNCTUATORS = [
  '<<<', '>>>', '===', '!==',
  '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '~&', '~|', '~^', '^~', '**', '+:', '-:',
  '(', ')', '[', ']', '{', '}', ';', ',', '.', ':', '?', '#', '@',
  '=', '+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<', '>',
] as const;

export type Punct = (typeof PUNCTUATORS)[number];

/**
 * A numeric literal after lexing.
 *
 * `bits` is a bigint because Verilog vectors are often wider than 53 bits (the
 * largest integer a JS number holds exactly). Using bigint from the start means
 * a 64-bit counter just works.
 */
export interface NumberValue {
  /** Declared width, e.g. 8 for `8'hFF`; null for unsized literals like `42` or `'hFF`. */
  width: number | null;
  signed: boolean;
  base: 2 | 8 | 10 | 16;
  bits: bigint;
}

/**
 * Tokens are a discriminated union on `kind`, so after checking `tok.kind ===
 * 'number'` TypeScript knows `tok.value` exists.
 */
export type Token =
  | { kind: 'ident'; text: string; span: Span }
  | { kind: 'keyword'; text: Keyword; span: Span }
  | { kind: 'systemIdent'; text: string; span: Span } // $display, $finish, $time
  | { kind: 'number'; text: string; span: Span; value: NumberValue }
  | { kind: 'string'; text: string; span: Span; value: string }
  | { kind: 'punct'; text: Punct; span: Span }
  | { kind: 'eof'; text: ''; span: Span };

export type TokenKind = Token['kind'];
