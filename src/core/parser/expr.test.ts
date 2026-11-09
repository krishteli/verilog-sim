import { describe, expect, it } from 'vitest';
import { parseExpression } from './parser';
import { expectVerilogError, sexpr } from './test-utils';

const p = (src: string) => sexpr(parseExpression(src));

describe('parser: operator precedence', () => {
  it.each([
    ['a + b * c', '(+ a (* b c))'],
    ['a * b + c', '(+ (* a b) c)'],
    ['a + b << 1', '(<< (+ a b) 1)'],
    ['a << 1 < b', '(< (<< a 1) b)'],
    ['a < b == c', '(== (< a b) c)'],
    ['a == b & c', '(& (== a b) c)'],
    ['a & b ^ c', '(^ (& a b) c)'],
    ['a ^ b | c', '(| (^ a b) c)'],
    ['a | b && c', '(&& (| a b) c)'],
    ['a && b || c', '(|| (&& a b) c)'],
    ['a ** b * c', '(* (** a b) c)'],
    ['a + b ~^ c', '(~^ (+ a b) c)'],
  ])('%s', (src, expected) => {
    expect(p(src)).toBe(expected);
  });

  it('binds unary tighter than any binary operator', () => {
    expect(p('-a * b')).toBe('(* (- a) b)');
    expect(p('!a && b')).toBe('(&& (! a) b)');
    expect(p('~a & b')).toBe('(& (~ a) b)');
  });

  it('honours parentheses', () => {
    expect(p('(a + b) * c')).toBe('(* (+ a b) c)');
  });
});

describe('parser: associativity', () => {
  it('groups binary operators left to right', () => {
    expect(p('a - b - c')).toBe('(- (- a b) c)');
    expect(p('a / b * c')).toBe('(* (/ a b) c)');
    expect(p('a ** b ** c')).toBe('(** (** a b) c)');
  });

  it('groups the conditional operator right to left', () => {
    expect(p('s ? a : t ? b : c')).toBe('(? s a (? t b c))');
  });

  it('gives ?: the lowest precedence', () => {
    expect(p('a | b ? c + 1 : d')).toBe('(? (| a b) (+ c 1) d)');
  });
});

describe('parser: unary operators', () => {
  it('parses reduction operators as unary', () => {
    expect(p('&bus')).toBe('(& bus)');
    expect(p('~|bus')).toBe('(~| bus)');
    expect(p('^~bus')).toBe('(^~ bus)');
  });

  it('distinguishes unary from binary minus by position', () => {
    expect(p('a - -b')).toBe('(- a (- b))');
  });

  it('nests unary operators', () => {
    expect(p('!~a')).toBe('(! (~ a))');
  });
});

describe('parser: primaries and selects', () => {
  it('parses bit, range and indexed part selects', () => {
    expect(p('a[3]')).toBe('(index a 3)');
    expect(p('a[7:4]')).toBe('(range a 7 4)');
    expect(p('a[W-1:0]')).toBe('(range a (- W 1) 0)');
    expect(p('a[i +: 4]')).toBe('(+: a i 4)');
    expect(p('a[i -: 4]')).toBe('(-: a i 4)');
  });

  it('binds selects tighter than unary operators', () => {
    expect(p('~a[0]')).toBe('(~ (index a 0))');
  });

  it('parses concatenation and replication', () => {
    expect(p("{a, b[3:0], 4'hF}")).toBe("{a (range b 3 0) 4'15}");
    expect(p('{4{a}}')).toBe('{4 x a}');
    expect(p('{2{a, b}}')).toBe('{2 x a b}');
    expect(p('{ {4{s}}, s }')).toBe('{{4 x s} s}');
  });

  it('parses system function calls as values', () => {
    expect(p('$time')).toBe('$time');
    expect(p('$signed(a) + 1')).toBe('(+ ($signed a) 1)');
  });

  it('includes parentheses in the span', () => {
    const e = parseExpression('(a + b)');
    expect([e.span.start, e.span.end]).toEqual([0, 7]);
  });

  it('spans a binary expression from left operand to right operand', () => {
    const src = 'x + y * z';
    const e = parseExpression(src);
    expect(src.slice(e.span.start, e.span.end)).toBe(src);
  });
});

describe('parser: expression errors', () => {
  it('reports a missing operand at the offending token', () => {
    const err = expectVerilogError(() => parseExpression('a + )'));
    expect(err.message).toMatch(/expected an expression, but found '\)'/);
    expect(err.span.col).toBe(5);
  });

  it('reports an unclosed parenthesis at end of input', () => {
    expect(expectVerilogError(() => parseExpression('(a + b')).message).toMatch(/to close the parenthesis, but found end of file/);
  });

  it('reports a missing ":" in a conditional', () => {
    expect(expectVerilogError(() => parseExpression('s ? a b')).message).toMatch(/expected ':'/);
  });

  it('rejects user function calls as unsupported', () => {
    expect(expectVerilogError(() => parseExpression('f(a)')).message).toMatch(/function calls are not supported/);
  });

  it('rejects trailing tokens', () => {
    expect(expectVerilogError(() => parseExpression('a b')).message).toMatch(/expected end of input/);
  });
});
