import { describe, expect, it } from 'vitest';
import { VerilogError } from '../diagnostics';
import { tokenize } from './lexer';
import type { Token } from './token';

/** Compact `kind:text` view of a token stream, minus the trailing eof. */
function kinds(src: string): string[] {
  return tokenize(src)
    .filter((t) => t.kind !== 'eof')
    .map((t) => `${t.kind}:${t.text}`);
}

function num(src: string) {
  const [tok] = tokenize(src);
  if (tok?.kind !== 'number') throw new Error(`expected number, got ${tok?.kind}`);
  return tok.value;
}

function lexError(src: string): VerilogError {
  try {
    tokenize(src);
  } catch (e) {
    if (e instanceof VerilogError) return e;
    throw e;
  }
  throw new Error('expected a VerilogError');
}

describe('lexer: identifiers and keywords', () => {
  it('separates keywords from identifiers', () => {
    expect(kinds('module counter endmodule')).toEqual(['keyword:module', 'ident:counter', 'keyword:endmodule']);
  });

  it('allows _ and $ inside identifiers and keeps case', () => {
    expect(kinds('_tmp a$b Clk_2')).toEqual(['ident:_tmp', 'ident:a$b', 'ident:Clk_2']);
  });

  it('treats keywords as case-sensitive', () => {
    expect(kinds('Module')).toEqual(['ident:Module']);
  });

  it('lexes escaped identifiers without the backslash', () => {
    expect(kinds('\\bus[0] x')).toEqual(['ident:bus[0]', 'ident:x']);
  });

  it('lexes system task names', () => {
    expect(kinds('$display $finish')).toEqual(['systemIdent:$display', 'systemIdent:$finish']);
  });

  it('reserves unsupported keywords so the parser can reject them clearly', () => {
    expect(kinds('for generate')).toEqual(['keyword:for', 'keyword:generate']);
  });
});

describe('lexer: numbers', () => {
  it('lexes unsized decimals as signed with no width', () => {
    expect(num('42')).toEqual({ width: null, signed: true, base: 10, bits: 42n });
  });

  it('ignores underscores', () => {
    expect(num('1_000').bits).toBe(1000n);
    expect(num("8'b1010_0101").bits).toBe(0b10100101n);
  });

  it.each([
    ["4'b1010", 4, 2, 10n],
    ["8'o17", 8, 8, 15n],
    ["8'd255", 8, 10, 255n],
    ["16'hBEEF", 16, 16, 0xbeefn],
    ["16'hbeef", 16, 16, 0xbeefn],
    ["4'B1111", 4, 2, 15n],
  ] as const)('lexes sized literal %s', (src, width, base, bits) => {
    expect(num(src)).toEqual({ width, signed: false, base, bits });
  });

  it('lexes unsized based literals', () => {
    expect(num("'hFF")).toEqual({ width: null, signed: false, base: 16, bits: 255n });
  });

  it('lexes signed based literals', () => {
    expect(num("8'sd5")).toEqual({ width: 8, signed: true, base: 10, bits: 5n });
  });

  it('allows whitespace between size, base and digits', () => {
    expect(num("8 'h FF")).toEqual({ width: 8, signed: false, base: 16, bits: 255n });
  });

  it('truncates literals wider than their declared size', () => {
    expect(num("4'hFF").bits).toBe(0xfn);
  });

  it('handles values wider than 53 bits exactly', () => {
    expect(num("64'hFFFF_FFFF_FFFF_FFFF").bits).toBe(2n ** 64n - 1n);
  });

  it('keeps the full source text of a literal', () => {
    expect(tokenize("8'hFF")[0]!.text).toBe("8'hFF");
  });

  it('does not join a decimal with a following tick-free token', () => {
    expect(kinds('a = 3 ;')).toEqual(['ident:a', 'punct:=', 'number:3', 'punct:;']);
  });

  it('rejects x/z digits with a 2-state message', () => {
    expect(lexError("4'bx01z").message).toMatch(/2-state/);
  });

  it('rejects digits that are invalid for the base', () => {
    expect(lexError("4'b102").message).toMatch(/invalid digit for base 2/);
    expect(lexError("8'o9").message).toMatch(/invalid digit for base 8/);
  });

  it('rejects zero-width and digitless literals', () => {
    expect(lexError("0'b1").message).toMatch(/width of at least 1/);
    expect(lexError("8'h;").message).toMatch(/missing digits/);
  });

  it('rejects a tick with no base', () => {
    expect(lexError("'q").message).toMatch(/expected a base/);
  });

  it('rejects real numbers', () => {
    expect(lexError('1.5').message).toMatch(/real numbers/);
  });
});

describe('lexer: operators and punctuation', () => {
  it('uses maximal munch', () => {
    expect(kinds('<<< << < <= === == =')).toEqual([
      'punct:<<<', 'punct:<<', 'punct:<', 'punct:<=', 'punct:===', 'punct:==', 'punct:=',
    ]);
  });

  it('lexes reduction and xnor operators', () => {
    expect(kinds('~& ~| ~^ ^~ ~')).toEqual(['punct:~&', 'punct:~|', 'punct:~^', 'punct:^~', 'punct:~']);
  });

  it('lexes @(*) as three tokens, not an attribute', () => {
    expect(kinds('@(*)')).toEqual(['punct:@', 'punct:(', 'punct:*', 'punct:)']);
  });

  it('lexes indexed part-select operators', () => {
    expect(kinds('a[i+:4]')).toEqual(['ident:a', 'punct:[', 'ident:i', 'punct:+:', 'number:4', 'punct:]']);
  });

  it('rejects unknown characters with a position', () => {
    const err = lexError('wire a;\n  a § b');
    expect(err.message).toMatch(/unexpected character '§'/);
    expect(err.span).toMatchObject({ line: 2, col: 5 });
  });
});

describe('lexer: strings, comments and directives', () => {
  it('decodes string escapes', () => {
    const [tok] = tokenize('"a=%d\\n\\"q\\""');
    expect(tok).toMatchObject({ kind: 'string', value: 'a=%d\n"q"' });
  });

  it('rejects unterminated strings', () => {
    expect(lexError('"abc\n"').message).toMatch(/unterminated string/);
  });

  it('skips line and block comments', () => {
    expect(kinds('a // comment\n/* multi\nline */ b')).toEqual(['ident:a', 'ident:b']);
  });

  it('rejects unterminated block comments at the comment start', () => {
    const err = lexError('a\n  /* never closed');
    expect(err.message).toMatch(/unterminated block comment/);
    expect(err.span).toMatchObject({ line: 2, col: 3 });
  });

  it('skips `timescale lines', () => {
    expect(kinds('`timescale 1ns/1ps\nmodule')).toEqual(['keyword:module']);
  });

  it('rejects unsupported directives by name', () => {
    expect(lexError('`define W 8').message).toMatch(/`define is not supported/);
  });
});

describe('lexer: source positions', () => {
  it('tracks 1-based line and column across newlines', () => {
    const toks = tokenize('module m;\n  wire a;\nendmodule');
    const wire = toks.find((t) => t.text === 'wire')!;
    expect(wire.span).toMatchObject({ line: 2, col: 3 });
    const end = toks.find((t) => t.text === 'endmodule')!;
    expect(end.span).toMatchObject({ line: 3, col: 1 });
  });

  it('records offsets that slice back to the token text', () => {
    const src = "assign y = 8'hFF & b;";
    for (const t of tokenize(src)) {
      expect(src.slice(t.span.start, t.span.end)).toBe(t.text);
    }
  });

  it('always ends with an eof token', () => {
    const toks: Token[] = tokenize('   ');
    expect(toks).toHaveLength(1);
    expect(toks[0]!.kind).toBe('eof');
  });

  it('prefixes error messages with line:col', () => {
    expect(lexError('\n\n   "oops').message).toMatch(/^3:4: /);
  });
});
