import { VerilogError } from '../diagnostics';
import type * as A from './ast';

/**
 * Render an expression as a fully parenthesized S-expression, e.g.
 * `a + b * c` -> `(+ a (* b c))`. Precedence tests compare against these
 * strings, which are far easier to read than nested AST objects.
 */
export function sexpr(e: A.Expr): string {
  switch (e.kind) {
    case 'Ident':
      return e.name;
    case 'Number':
      return e.value.width === null ? `${e.value.bits}` : `${e.value.width}'${e.value.bits}`;
    case 'String':
      return JSON.stringify(e.value);
    case 'Unary':
      return `(${e.op} ${sexpr(e.operand)})`;
    case 'Binary':
      return `(${e.op} ${sexpr(e.left)} ${sexpr(e.right)})`;
    case 'Ternary':
      return `(? ${sexpr(e.cond)} ${sexpr(e.then)} ${sexpr(e.else)})`;
    case 'Index':
      return `(index ${sexpr(e.target)} ${sexpr(e.index)})`;
    case 'RangeSelect':
      return `(range ${sexpr(e.target)} ${sexpr(e.msb)} ${sexpr(e.lsb)})`;
    case 'PartSelect':
      return `(${e.dir} ${sexpr(e.target)} ${sexpr(e.base)} ${sexpr(e.width)})`;
    case 'Concat':
      return `{${e.parts.map(sexpr).join(' ')}}`;
    case 'Replicate':
      return `{${sexpr(e.count)} x ${e.parts.map(sexpr).join(' ')}}`;
    case 'SystemCall':
      return e.args.length ? `(${e.name} ${e.args.map(sexpr).join(' ')})` : e.name;
  }
}

/** Run `fn` and return the VerilogError it throws, failing the test if it doesn't. */
export function expectVerilogError(fn: () => unknown): VerilogError {
  try {
    fn();
  } catch (e) {
    if (e instanceof VerilogError) return e;
    throw e;
  }
  throw new Error('expected a VerilogError to be thrown');
}
