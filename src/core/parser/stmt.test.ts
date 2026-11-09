import { describe, expect, it } from 'vitest';
import type * as A from './ast';
import { parseStatement } from './parser';
import { expectVerilogError, sexpr } from './test-utils';

/** Narrow a statement to one kind, failing the test otherwise. */
function as<K extends A.Stmt['kind']>(s: A.Stmt | null, kind: K): Extract<A.Stmt, { kind: K }> {
  expect(s?.kind).toBe(kind);
  return s as Extract<A.Stmt, { kind: K }>;
}

describe('parser: procedural assignments', () => {
  it('parses blocking assignment', () => {
    const s = as(parseStatement('a = b + 1;'), 'ProceduralAssign');
    expect(s.blocking).toBe(true);
    expect(sexpr(s.lhs)).toBe('a');
    expect(sexpr(s.rhs)).toBe('(+ b 1)');
  });

  it('parses nonblocking assignment', () => {
    const s = as(parseStatement('q <= d;'), 'ProceduralAssign');
    expect(s.blocking).toBe(false);
  });

  it('treats the first <= as assignment and later ones as comparison', () => {
    const s = as(parseStatement('ok <= a <= b;'), 'ProceduralAssign');
    expect(s.blocking).toBe(false);
    expect(sexpr(s.rhs)).toBe('(<= a b)');
  });

  it('accepts selects and concatenations as targets', () => {
    expect(sexpr(as(parseStatement('q[3:0] <= 0;'), 'ProceduralAssign').lhs)).toBe('(range q 3 0)');
    expect(sexpr(as(parseStatement('{c, s} = a + b;'), 'ProceduralAssign').lhs)).toBe('{c s}');
  });

  it('rejects expressions that cannot be assigned to', () => {
    expect(expectVerilogError(() => parseStatement('a + b = c;')).message).toMatch(/expected '=' or '<='/);
    expect(expectVerilogError(() => parseStatement('{a, 1} = c;')).message).toMatch(/assignment target/);
  });

  it('rejects intra-assignment delays as unsupported', () => {
    expect(expectVerilogError(() => parseStatement('a = #5 b;')).message).toMatch(/intra-assignment/);
  });

  it('reports a missing semicolon at the next token', () => {
    const err = expectVerilogError(() => parseStatement('begin a = 1 b = 2; end'));
    expect(err.message).toMatch(/expected ';' after assignment, but found 'b'/);
    expect(err.span.col).toBe(13);
  });
});

describe('parser: if and case', () => {
  it('parses if/else', () => {
    const s = as(parseStatement('if (rst) q <= 0; else q <= d;'), 'If');
    expect(sexpr(s.cond)).toBe('rst');
    expect(s.else).not.toBeNull();
  });

  it('attaches a dangling else to the nearest if', () => {
    const outer = as(parseStatement('if (a) if (b) x = 1; else x = 2;'), 'If');
    expect(outer.else).toBeNull();
    expect(as(outer.then, 'If').else).not.toBeNull();
  });

  it('parses else-if chains', () => {
    const s = as(parseStatement('if (a) x = 1; else if (b) x = 2; else x = 3;'), 'If');
    expect(as(as(s.else, 'If').else, 'ProceduralAssign')).toBeTruthy();
  });

  it('parses case with multiple labels and default', () => {
    const s = as(
      parseStatement(`
        case (op)
          2'b00: y = a + b;
          2'b01, 2'b10: y = a - b;
          default: y = 0;
        endcase`),
      'Case',
    );
    expect(sexpr(s.subject)).toBe('op');
    expect(s.items).toHaveLength(2);
    expect(s.items[1]!.labels.map(sexpr)).toEqual(["2'1", "2'2"]);
    expect(s.default).not.toBeNull();
  });

  it('allows default without a colon and a case with no default', () => {
    expect(as(parseStatement('case (s) default y = 0; endcase'), 'Case').default).not.toBeNull();
    expect(as(parseStatement('case (s) 0: y = 1; endcase'), 'Case').default).toBeNull();
  });

  it('rejects two defaults', () => {
    expect(expectVerilogError(() => parseStatement('case (s) default: ; default: ; endcase')).message).toMatch(/only have one default/);
  });

  it('rejects casez as unsupported', () => {
    expect(expectVerilogError(() => parseStatement('casez (s) endcase')).message).toMatch(/'casez' is not supported yet/);
  });

  it('reports an unclosed case with the line it opened on', () => {
    expect(expectVerilogError(() => parseStatement('\ncase (s)\n 0: y = 1;')).message).toMatch(/'endcase' to close 'case' at line 2/);
  });
});

describe('parser: blocks', () => {
  it('parses begin/end with statements', () => {
    const s = as(parseStatement('begin a = 1; b = 2; end'), 'Block');
    expect(s.name).toBeNull();
    expect(s.stmts).toHaveLength(2);
  });

  it('parses named blocks', () => {
    expect(as(parseStatement('begin : init a = 1; end'), 'Block').name).toBe('init');
  });

  it('parses empty blocks and null statements', () => {
    expect(as(parseStatement('begin end'), 'Block').stmts).toEqual([]);
    as(parseStatement(';'), 'Null');
  });

  it('rejects for loops as unsupported', () => {
    expect(expectVerilogError(() => parseStatement('for (i = 0; i < 4; i = i + 1) ;')).message).toMatch(/'for' is not supported yet/);
  });
});

describe('parser: timing controls', () => {
  it('parses #delay with and without a statement', () => {
    const d = as(parseStatement('#10 a = 1;'), 'Delay');
    expect(sexpr(d.amount)).toBe('10');
    as(d.body, 'ProceduralAssign');
    expect(as(parseStatement('#5;'), 'Delay').body).toBeNull();
  });

  it('parses parameter and parenthesized delays', () => {
    expect(sexpr(as(parseStatement('#PERIOD;'), 'Delay').amount)).toBe('PERIOD');
    expect(sexpr(as(parseStatement('#(PERIOD/2) clk = ~clk;'), 'Delay').amount)).toBe('(/ PERIOD 2)');
  });

  it('parses @(*) and @*', () => {
    expect(as(parseStatement('@(*) y = a;'), 'EventControl').sensitivity.kind).toBe('Star');
    expect(as(parseStatement('@* y = a;'), 'EventControl').sensitivity.kind).toBe('Star');
  });

  it('parses edge lists separated by "or" or commas', () => {
    for (const src of ['@(posedge clk or negedge rst_n) q <= d;', '@(posedge clk, negedge rst_n) q <= d;']) {
      const sens = as(parseStatement(src), 'EventControl').sensitivity;
      if (sens.kind !== 'List') throw new Error('expected list');
      expect(sens.items.map((i) => [i.edge, sexpr(i.signal)])).toEqual([
        ['posedge', 'clk'],
        ['negedge', 'rst_n'],
      ]);
    }
  });

  it('parses level-sensitive lists', () => {
    const sens = as(parseStatement('@(a or b) y = a & b;'), 'EventControl').sensitivity;
    expect(sens.kind === 'List' && sens.items.map((i) => i.edge)).toEqual([null, null]);
  });

  it('parses a bare event wait in a testbench', () => {
    expect(as(parseStatement('@(posedge clk);'), 'EventControl').body).toBeNull();
  });
});

describe('parser: system tasks', () => {
  it('parses $display with a format string and arguments', () => {
    const s = as(parseStatement('$display("q=%d t=%0t", q, $time);'), 'SystemTaskCall');
    expect(s.name).toBe('$display');
    expect(s.args.map(sexpr)).toEqual(['"q=%d t=%0t"', 'q', '$time']);
  });

  it('parses argument-free tasks with or without parentheses', () => {
    expect(as(parseStatement('$finish;'), 'SystemTaskCall').args).toEqual([]);
    expect(as(parseStatement('$finish();'), 'SystemTaskCall').args).toEqual([]);
  });
});
