import { VerilogError, type Span } from '../diagnostics';
import { tokenize } from '../lexer/lexer';
import type { Keyword, Punct, Token } from '../lexer/token';
import type * as A from './ast';

/**
 * Parse a Verilog source file into an AST. Throws a VerilogError at the first
 * syntax error.
 *
 * This is a hand-written recursive-descent parser: roughly one method per
 * grammar rule (parseModule, parseStatement, ...), each consuming tokens and
 * calling the others. Compared with a parser generator, it's more code but
 * needs no build step, gives full control over error messages, and is easy to
 * step through in a debugger — all useful in a teaching-oriented project.
 */
export function parse(source: string): A.SourceFile {
  return new Parser(tokenize(source)).parseSourceFile();
}

/** Parse a single expression. Exposed for tests and, later, for watch expressions in the UI. */
export function parseExpression(source: string): A.Expr {
  const p = new Parser(tokenize(source));
  const e = p.parseExpr();
  p.expectEof();
  return e;
}

/** Parse a single statement (for tests). */
export function parseStatement(source: string): A.Stmt {
  const p = new Parser(tokenize(source));
  const s = p.parseStmt();
  p.expectEof();
  return s;
}

/**
 * Binary operator precedence, higher binds tighter (IEEE 1364-2005 Table 5-4).
 * All binary operators are left-associative; `?:` (lowest) is handled
 * separately because it's ternary and right-associative.
 *
 * A table plus one loop ("precedence climbing") replaces the classic chain of
 * eleven near-identical functions (parseLogicalOr -> parseLogicalAnd -> ...).
 */
const BINARY_PRECEDENCE: Partial<Record<Punct, number>> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4, '~^': 4, '^~': 4,
  '&': 5,
  '==': 6, '!=': 6, '===': 6, '!==': 6,
  '<': 7, '<=': 7, '>': 7, '>=': 7,
  '<<': 8, '>>': 8, '<<<': 8, '>>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
  '**': 11,
};

const UNARY_OPS: ReadonlySet<string> = new Set(['+', '-', '!', '~', '&', '|', '^', '~&', '~|', '~^', '^~']);

/** Keywords that are reserved but outside the v1 subset, with a hint for the error message. */
const UNSUPPORTED_ITEM_KEYWORDS: ReadonlySet<string> = new Set([
  'for', 'while', 'repeat', 'forever', 'function', 'task', 'generate', 'genvar',
  'tri', 'supply0', 'supply1', 'real', 'time', 'casez', 'casex',
]);

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  // ---- token helpers ----------------------------------------------------------

  private get tok(): Token {
    return this.tokens[this.pos]!;
  }

  /** The most recently consumed token; used to close spans. */
  private get prev(): Token {
    return this.tokens[this.pos - 1]!;
  }

  private next(): Token {
    const t = this.tok;
    if (t.kind !== 'eof') this.pos++;
    return t;
  }

  private isPunct(p: Punct, t: Token = this.tok): boolean {
    return t.kind === 'punct' && t.text === p;
  }

  private isKeyword(k: Keyword, t: Token = this.tok): boolean {
    return t.kind === 'keyword' && t.text === k;
  }

  private eatPunct(p: Punct): boolean {
    if (!this.isPunct(p)) return false;
    this.pos++;
    return true;
  }

  private eatKeyword(k: Keyword): boolean {
    if (!this.isKeyword(k)) return false;
    this.pos++;
    return true;
  }

  /** Consume `p` or fail with "expected 'p' <context> but found ...". */
  private expectPunct(p: Punct, context: string): Token {
    if (!this.isPunct(p)) this.fail(`expected '${p}' ${context}`);
    return this.next();
  }

  private expectKeyword(k: Keyword, context: string): Token {
    if (!this.isKeyword(k)) this.fail(`expected '${k}' ${context}`);
    return this.next();
  }

  private expectIdent(context: string): Extract<Token, { kind: 'ident' }> {
    const t = this.tok;
    if (t.kind !== 'ident') {
      if (t.kind === 'keyword') this.failAt(`expected ${context}, but '${t.text}' is a reserved keyword`, t.span);
      this.fail(`expected ${context}`);
    }
    this.pos++;
    return t;
  }

  expectEof(): void {
    if (this.tok.kind !== 'eof') this.fail('expected end of input');
  }

  private describe(t: Token): string {
    return t.kind === 'eof' ? 'end of file' : `'${t.text}'`;
  }

  /** Throw at the current token, appending what we actually saw. */
  private fail(message: string, at: Token = this.tok): never {
    throw new VerilogError(`${message}, but found ${this.describe(at)}`, at.span);
  }

  /** Throw at an arbitrary span with an exact message. */
  private failAt(message: string, span: Span): never {
    throw new VerilogError(message, span);
  }

  /** Span from `start` to the end of the last consumed token. */
  private spanFrom(start: Token | Span): Span {
    const s = 'span' in start ? start.span : start;
    return { start: s.start, end: this.prev.span.end, line: s.line, col: s.col };
  }

  // ---- source file and modules ----------------------------------------------

  parseSourceFile(): A.SourceFile {
    const start = this.tok;
    const modules: A.ModuleDecl[] = [];
    while (this.tok.kind !== 'eof') {
      if (!this.isKeyword('module')) this.fail("expected 'module'");
      modules.push(this.parseModule());
    }
    const span = modules.length ? this.spanFrom(start) : start.span;
    return { kind: 'SourceFile', modules, span };
  }

  private parseModule(): A.ModuleDecl {
    const start = this.expectKeyword('module', 'to start a module');
    const name = this.expectIdent('a module name').text;

    const params: A.ParamDecl[] = [];
    if (this.eatPunct('#')) {
      this.expectPunct('(', "after '#' in the module header");
      if (!this.isPunct(')')) {
        do {
          if (!this.isKeyword('parameter') && !this.isKeyword('localparam') && params.length === 0) {
            this.fail("expected 'parameter' in the module parameter list");
          }
          params.push(this.parseHeaderParam());
        } while (this.eatPunct(','));
      }
      this.expectPunct(')', 'to close the module parameter list');
    }

    let ports: A.PortDecl[] = [];
    if (this.eatPunct('(')) {
      ports = this.parsePortList();
      this.expectPunct(')', 'to close the port list');
    }
    this.expectPunct(';', 'after the module header');

    const items: A.ModuleItem[] = [];
    while (!this.isKeyword('endmodule')) {
      if (this.tok.kind === 'eof') this.fail(`expected 'endmodule' to close module '${name}'`);
      items.push(...this.parseModuleItem());
    }
    this.next(); // endmodule
    return { kind: 'Module', name, params, ports, items, span: this.spanFrom(start) };
  }

  /**
   * One entry of `#(parameter W = 8, D = 2)`. A new `parameter` keyword starts a
   * new declaration; a bare `D = 2` continues the previous one, so each entry
   * becomes its own single-assignment ParamDecl.
   */
  private parseHeaderParam(): A.ParamDecl {
    const start = this.tok;
    let local = false;
    let signed = false;
    let range: A.Range | null = null;
    if (this.isKeyword('parameter') || this.isKeyword('localparam')) {
      local = this.next().text === 'localparam';
      signed = this.eatKeyword('signed');
      range = this.parseOptionalRange();
    }
    const assignment = this.parseParamAssignment();
    return { kind: 'ParamDecl', local, signed, range, assignments: [assignment], span: this.spanFrom(start) };
  }

  private parseParamAssignment(): A.ParamAssignment {
    const nameTok = this.expectIdent('a parameter name');
    this.expectPunct('=', `after parameter '${nameTok.text}' (parameters need a default value)`);
    const value = this.parseExpr();
    return { name: nameTok.text, value, span: this.spanFrom(nameTok) };
  }

  /**
   * ANSI port list: `input wire [7:0] a, b, output reg y`.
   *
   * A direction keyword starts a new group; a bare identifier after a comma
   * inherits the group's direction, type and range. Leading-comma style
   *     ( input a
   *     , input b )
   * needs no special handling — commas are separators wherever they appear on
   * the line. A bare identifier as the *first* port means an old-style
   * (non-ANSI) header, which we reject with a pointed message.
   */
  private parsePortList(): A.PortDecl[] {
    const ports: A.PortDecl[] = [];
    if (this.isPunct(')')) return ports;

    let group: Omit<A.PortDecl, 'kind' | 'name' | 'span'> | null = null;
    do {
      const start = this.tok;
      if (this.isKeyword('input') || this.isKeyword('output') || this.isKeyword('inout')) {
        const direction = this.next().text as A.Direction;
        let netType: A.NetType = 'wire';
        if (this.isKeyword('wire') || this.isKeyword('reg') || this.isKeyword('integer')) {
          netType = this.next().text as A.NetType;
        }
        if (netType === 'reg' && direction === 'input') {
          this.failAt("an input port cannot be declared 'reg'", this.prev.span);
        }
        const signed = this.eatKeyword('signed');
        const range = this.parseOptionalRange();
        group = { direction, netType, signed, range };
      } else if (this.tok.kind === 'ident' && group === null) {
        this.fail(
          'non-ANSI port lists are not supported; declare each port\'s direction in the header, e.g. "module m(input a, output y);"',
        );
      } else if (group === null) {
        this.fail('expected a port declaration such as \'input a\'');
      }
      const name = this.expectIdent('a port name').text;
      ports.push({ kind: 'Port', ...group, name, span: this.spanFrom(start) });
    } while (this.eatPunct(','));
    return ports;
  }

  private parseOptionalRange(): A.Range | null {
    if (!this.isPunct('[')) return null;
    const start = this.next();
    const msb = this.parseExpr();
    this.expectPunct(':', "in range '[msb:lsb]'");
    const lsb = this.parseExpr();
    this.expectPunct(']', "to close range '[msb:lsb]'");
    return { msb, lsb, span: this.spanFrom(start) };
  }

  // ---- module items ------------------------------------------------------------

  /** Returns an array because `mod u0(...), u1(...);` declares several instances in one statement. */
  private parseModuleItem(): A.ModuleItem[] {
    const t = this.tok;
    if (t.kind === 'keyword') {
      switch (t.text) {
        case 'wire':
        case 'reg':
        case 'integer':
          return [this.parseNetDecl()];
        case 'parameter':
        case 'localparam':
          return [this.parseParamDecl()];
        case 'assign':
          return [this.parseContinuousAssign()];
        case 'always': {
          this.next();
          return [{ kind: 'Always', body: this.parseStmt(), span: this.spanFrom(t) }];
        }
        case 'initial': {
          this.next();
          return [{ kind: 'Initial', body: this.parseStmt(), span: this.spanFrom(t) }];
        }
        case 'input':
        case 'output':
        case 'inout':
          this.fail('port declarations belong in the module header (ANSI style)');
        case 'module':
          this.fail("modules cannot be nested; did you forget 'endmodule'?");
      }
      if (UNSUPPORTED_ITEM_KEYWORDS.has(t.text)) this.failAt(`'${t.text}' is not supported yet`, t.span);
    }
    if (t.kind === 'ident') return this.parseInstances();
    this.fail('expected a module item (declaration, assign, always, initial or instance)');
  }

  private parseNetDecl(): A.NetDecl {
    const start = this.next();
    const netType = start.text as A.NetType;
    const signed = this.eatKeyword('signed');
    const range = netType === 'integer' ? null : this.parseOptionalRange();
    const declarators: A.Declarator[] = [];
    do {
      const nameTok = this.expectIdent(`a ${netType} name`);
      if (this.isPunct('[')) this.failAt('memories (arrays) are not supported yet', this.tok.span);
      const init = this.eatPunct('=') ? this.parseExpr() : null;
      declarators.push({ name: nameTok.text, init, span: this.spanFrom(nameTok) });
    } while (this.eatPunct(','));
    this.expectPunct(';', `after ${netType} declaration`);
    return { kind: 'NetDecl', netType, signed, range, declarators, span: this.spanFrom(start) };
  }

  private parseParamDecl(): A.ParamDecl {
    const start = this.next();
    const local = start.text === 'localparam';
    const signed = this.eatKeyword('signed');
    const range = this.parseOptionalRange();
    const assignments: A.ParamAssignment[] = [];
    do assignments.push(this.parseParamAssignment());
    while (this.eatPunct(','));
    this.expectPunct(';', `after ${start.text} declaration`);
    return { kind: 'ParamDecl', local, signed, range, assignments, span: this.spanFrom(start) };
  }

  private parseContinuousAssign(): A.ContinuousAssign {
    const start = this.next();
    const assignments: A.ContinuousAssign['assignments'] = [];
    do {
      const lhsStart = this.tok;
      const lhs = this.parseLValue();
      this.expectPunct('=', "in continuous assignment ('assign' uses '=')");
      const rhs = this.parseExpr();
      assignments.push({ lhs, rhs, span: this.spanFrom(lhsStart) });
    } while (this.eatPunct(','));
    this.expectPunct(';', 'after assign statement');
    return { kind: 'ContinuousAssign', assignments, span: this.spanFrom(start) };
  }

  private parseInstances(): A.Instance[] {
    const start = this.tok;
    const moduleName = this.expectIdent('a module name').text;
    let paramOverrides: A.Connection[] = [];
    if (this.eatPunct('#')) {
      this.expectPunct('(', "after '#' in parameter overrides");
      paramOverrides = this.parseConnections('parameter');
      this.expectPunct(')', 'to close parameter overrides');
    }

    const instances: A.Instance[] = [];
    do {
      const nameTok = this.tok;
      if (nameTok.kind !== 'ident') {
        // `foo = 1;` at module level is a common mistake; say so instead of "expected instance name".
        if (this.isPunct('=') || this.isPunct('<=')) {
          this.fail("assignments at module level need 'assign' (or belong inside an always/initial block)");
        }
        this.fail(`expected an instance name after module name '${moduleName}'`);
      }
      this.next();
      this.expectPunct('(', `after instance name '${nameTok.text}'`);
      const connections = this.parseConnections('port');
      this.expectPunct(')', `to close the port connections of '${nameTok.text}'`);
      instances.push({
        kind: 'Instance',
        moduleName,
        instanceName: nameTok.text,
        paramOverrides,
        connections,
        span: this.spanFrom(instances.length === 0 ? start : nameTok),
      });
    } while (this.eatPunct(','));
    this.expectPunct(';', 'after module instance');
    return instances;
  }

  /** `(.a(x), .b())` or `(x, y)` — but not a mix of both, which Verilog forbids. */
  private parseConnections(what: 'port' | 'parameter'): A.Connection[] {
    const conns: A.Connection[] = [];
    if (this.isPunct(')')) return conns;
    do {
      const start = this.tok;
      if (this.eatPunct('.')) {
        const name = this.expectIdent(`a ${what} name after '.'`).text;
        this.expectPunct('(', `after '.${name}'`);
        const expr = this.isPunct(')') ? null : this.parseExpr();
        this.expectPunct(')', `to close '.${name}('`);
        conns.push({ kind: 'Named', name, expr, span: this.spanFrom(start) });
      } else {
        conns.push({ kind: 'Positional', expr: this.parseExpr(), span: this.spanFrom(start) });
      }
    } while (this.eatPunct(','));
    const kinds = new Set(conns.map((c) => c.kind));
    if (kinds.size > 1) this.failAt(`cannot mix named and positional ${what} connections`, conns[0]!.span);
    return conns;
  }

  // ---- statements ----------------------------------------------------------------

  parseStmt(): A.Stmt {
    const t = this.tok;

    if (t.kind === 'punct') {
      switch (t.text) {
        case ';':
          this.next();
          return { kind: 'Null', span: t.span };
        case '#':
          return this.parseDelay();
        case '@':
          return this.parseEventControl();
        case '{':
          return this.parseProceduralAssign();
      }
    }
    if (t.kind === 'keyword') {
      switch (t.text) {
        case 'begin':
          return this.parseBlock();
        case 'if':
          return this.parseIf();
        case 'case':
          return this.parseCase();
      }
      if (UNSUPPORTED_ITEM_KEYWORDS.has(t.text)) this.failAt(`'${t.text}' is not supported yet`, t.span);
      if (t.text === 'assign') this.failAt("procedural 'assign' is not supported; use '=' or '<='", t.span);
    }
    if (t.kind === 'systemIdent') return this.parseSystemTaskCall();
    if (t.kind === 'ident') return this.parseProceduralAssign();
    this.fail('expected a statement');
  }

  private parseBlock(): A.Block {
    const start = this.next(); // begin
    let name: string | null = null;
    if (this.eatPunct(':')) name = this.expectIdent("a block name after 'begin :'").text;
    const stmts: A.Stmt[] = [];
    while (!this.isKeyword('end')) {
      if (this.tok.kind === 'eof') this.fail(`expected 'end' to close 'begin' at line ${start.span.line}`);
      stmts.push(this.parseStmt());
    }
    this.next(); // end
    return { kind: 'Block', name, stmts, span: this.spanFrom(start) };
  }

  /**
   * `else` binds to the nearest `if` (the "dangling else" rule). Recursive
   * descent gets this for free: the inner parseIf sees the `else` first.
   */
  private parseIf(): A.If {
    const start = this.next(); // if
    this.expectPunct('(', "after 'if'");
    const cond = this.parseExpr();
    this.expectPunct(')', 'to close the if condition');
    const then = this.parseStmt();
    const elseStmt = this.eatKeyword('else') ? this.parseStmt() : null;
    return { kind: 'If', cond, then, else: elseStmt, span: this.spanFrom(start) };
  }

  private parseCase(): A.Case {
    const start = this.next(); // case
    this.expectPunct('(', "after 'case'");
    const subject = this.parseExpr();
    this.expectPunct(')', 'to close the case expression');

    const items: A.CaseItem[] = [];
    let def: A.Stmt | null = null;
    while (!this.isKeyword('endcase')) {
      if (this.tok.kind === 'eof') this.fail(`expected 'endcase' to close 'case' at line ${start.span.line}`);
      const itemStart = this.tok;
      if (this.eatKeyword('default')) {
        if (def) this.failAt('a case statement can only have one default', itemStart.span);
        this.eatPunct(':'); // the colon after default is optional
        def = this.parseStmt();
        continue;
      }
      const labels: A.Expr[] = [];
      do labels.push(this.parseExpr());
      while (this.eatPunct(','));
      this.expectPunct(':', 'after case item label');
      const body = this.parseStmt();
      items.push({ labels, body, span: this.spanFrom(itemStart) });
    }
    this.next(); // endcase
    return { kind: 'Case', subject, items, default: def, span: this.spanFrom(start) };
  }

  /**
   * `lhs = rhs;` or `lhs <= rhs;`.
   *
   * The classic Verilog ambiguity: `<=` is both "nonblocking assign" and "less
   * than or equal". We resolve it by parsing the left side with parseLValue,
   * which only accepts names, selects and concatenations — never binary
   * operators — so it stops right before the `<=` and we know it's an assignment.
   * On the right side, parseExpr treats `<=` as a comparison as usual:
   * `ok <= a <= b;` means `ok <= (a <= b)`.
   */
  private parseProceduralAssign(): A.ProceduralAssign {
    const start = this.tok;
    const lhs = this.parseLValue();
    let blocking: boolean;
    if (this.eatPunct('=')) blocking = true;
    else if (this.eatPunct('<=')) blocking = false;
    else this.fail("expected '=' or '<=' in assignment");

    if (this.isPunct('#') || this.isPunct('@')) {
      this.failAt('intra-assignment delays (e.g. "a = #5 b") are not supported yet', this.tok.span);
    }
    const rhs = this.parseExpr();
    this.expectPunct(';', 'after assignment');
    return { kind: 'ProceduralAssign', blocking, lhs, rhs, span: this.spanFrom(start) };
  }

  private parseDelay(): A.Delay {
    const start = this.next(); // #
    const amount = this.parseDelayValue();
    return { kind: 'Delay', amount, body: this.parseOptionalBody(), span: this.spanFrom(start) };
  }

  /** `#10`, `#PERIOD` or `#(PERIOD/2)` — a bare `#a+b` is not allowed by the grammar. */
  private parseDelayValue(): A.Expr {
    const t = this.tok;
    if (this.eatPunct('(')) {
      const e = this.parseExpr();
      this.expectPunct(')', 'to close the delay expression');
      return e;
    }
    if (t.kind === 'number') {
      this.next();
      return { kind: 'Number', value: t.value, span: t.span };
    }
    if (t.kind === 'ident') {
      this.next();
      return { kind: 'Ident', name: t.text, span: t.span };
    }
    this.fail("expected a delay value after '#'");
  }

  private parseEventControl(): A.EventControl {
    const start = this.next(); // @
    const sensitivity = this.parseSensitivity();
    return { kind: 'EventControl', sensitivity, body: this.parseOptionalBody(), span: this.spanFrom(start) };
  }

  /** `@*`, `@(*)`, `@(posedge clk or negedge rst_n)`, `@(a, b)`. */
  private parseSensitivity(): A.Sensitivity {
    const start = this.tok;
    if (this.eatPunct('*')) return { kind: 'Star', span: start.span };
    this.expectPunct('(', "after '@'");
    if (this.eatPunct('*')) {
      this.expectPunct(')', "after '@(*'");
      return { kind: 'Star', span: this.spanFrom(start) };
    }
    const items: A.SensitivityItem[] = [];
    do {
      const itemStart = this.tok;
      let edge: A.SensitivityItem['edge'] = null;
      if (this.isKeyword('posedge') || this.isKeyword('negedge')) edge = this.next().text as 'posedge' | 'negedge';
      const signal = this.parseExpr();
      items.push({ edge, signal, span: this.spanFrom(itemStart) });
    } while (this.eatKeyword('or') || this.eatPunct(','));
    this.expectPunct(')', 'to close the sensitivity list');
    return { kind: 'List', items, span: this.spanFrom(start) };
  }

  /** After `#10` or `@(...)`, a bare `;` means "just wait", with no body statement. */
  private parseOptionalBody(): A.Stmt | null {
    if (this.eatPunct(';')) return null;
    return this.parseStmt();
  }

  private parseSystemTaskCall(): A.SystemTaskCall {
    const start = this.next();
    const args = this.parseSystemArgs();
    this.expectPunct(';', `after ${start.text}`);
    return { kind: 'SystemTaskCall', name: start.text, args, span: this.spanFrom(start) };
  }

  private parseSystemArgs(): A.Expr[] {
    const args: A.Expr[] = [];
    if (!this.eatPunct('(')) return args;
    if (!this.isPunct(')')) {
      do args.push(this.parseExpr());
      while (this.eatPunct(','));
    }
    this.expectPunct(')', 'to close the argument list');
    return args;
  }

  // ---- expressions ---------------------------------------------------------------

  /** Entry point: the conditional operator has the lowest precedence. */
  parseExpr(): A.Expr {
    const cond = this.parseBinary(1);
    if (!this.isPunct('?')) return cond;
    this.next();
    const then = this.parseExpr();
    this.expectPunct(':', "in conditional expression 'cond ? a : b'");
    const elseExpr = this.parseExpr(); // recursing here makes ?: right-associative
    return { kind: 'Ternary', cond, then, else: elseExpr, span: this.spanFrom(cond.span) };
  }

  /**
   * Precedence climbing. Parse an operand, then keep absorbing operators whose
   * precedence is at least `minPrec`. For each one, the right operand is parsed
   * with `prec + 1`, so an operator of the *same* level ends that operand and is
   * picked up by this loop instead — that's what makes `a - b - c` group as
   * `(a - b) - c` (left-associative).
   */
  private parseBinary(minPrec: number): A.Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.tok;
      const prec = t.kind === 'punct' ? BINARY_PRECEDENCE[t.text] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      this.next();
      const right = this.parseBinary(prec + 1);
      left = { kind: 'Binary', op: t.text as A.BinaryOp, left, right, span: this.spanFrom(left.span) };
    }
  }

  private parseUnary(): A.Expr {
    const t = this.tok;
    if (t.kind === 'punct' && UNARY_OPS.has(t.text)) {
      this.next();
      const operand = this.parseUnary();
      return { kind: 'Unary', op: t.text as A.UnaryOp, operand, span: this.spanFrom(t) };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  /** Bit and part selects: `a[3]`, `a[7:0]`, `a[i +: 4]`. They can chain: `a[7:0][3]` is rejected later if illegal. */
  private parsePostfix(target: A.Expr): A.Expr {
    while (this.isPunct('[')) {
      this.next();
      const first = this.parseExpr();
      if (this.eatPunct(':')) {
        const lsb = this.parseExpr();
        this.expectPunct(']', 'to close the part select');
        target = { kind: 'RangeSelect', target, msb: first, lsb, span: this.spanFrom(target.span) };
      } else if (this.isPunct('+:') || this.isPunct('-:')) {
        const dir = this.next().text as '+:' | '-:';
        const width = this.parseExpr();
        this.expectPunct(']', 'to close the part select');
        target = { kind: 'PartSelect', target, base: first, dir, width, span: this.spanFrom(target.span) };
      } else {
        this.expectPunct(']', 'to close the bit select');
        target = { kind: 'Index', target, index: first, span: this.spanFrom(target.span) };
      }
    }
    return target;
  }

  private parsePrimary(): A.Expr {
    const t = this.tok;
    switch (t.kind) {
      case 'ident': {
        this.next();
        if (this.isPunct('(')) this.failAt('function calls are not supported yet', t.span);
        // Hierarchical reference such as `dut.count`: kept as one dotted name,
        // resolved by the elaborator. (Named port connections `.a(x)` never get
        // here — they start with '.', not an identifier.)
        let name = t.text;
        while (this.isPunct('.') && this.tokens[this.pos + 1]?.kind === 'ident') {
          this.next();
          name += '.' + this.next().text;
        }
        return { kind: 'Ident', name, span: this.spanFrom(t) };
      }
      case 'number':
        this.next();
        return { kind: 'Number', value: t.value, span: t.span };
      case 'string':
        this.next();
        return { kind: 'String', value: t.value, span: t.span };
      case 'systemIdent': {
        this.next();
        const args = this.parseSystemArgs();
        return { kind: 'SystemCall', name: t.text, args, span: this.spanFrom(t) };
      }
      case 'punct':
        if (t.text === '(') {
          this.next();
          const e = this.parseExpr();
          this.expectPunct(')', 'to close the parenthesis');
          // Parentheses only affect grouping, so they don't get their own node,
          // but we widen the span so errors underline "(a + b)" including parens.
          return { ...e, span: this.spanFrom(t) };
        }
        if (t.text === '{') return this.parseConcat();
        break;
    }
    this.fail('expected an expression');
  }

  /** `{a, b}` or `{N{a, b}}`. Both start with `{ expr`; the next token tells them apart. */
  private parseConcat(): A.Expr {
    const start = this.next(); // {
    const first = this.parseExpr();
    if (this.isPunct('{')) {
      this.next();
      const parts = this.parseExprList();
      this.expectPunct('}', 'to close the replicated expression');
      this.expectPunct('}', 'to close the replication');
      return { kind: 'Replicate', count: first, parts, span: this.spanFrom(start) };
    }
    const parts = [first];
    while (this.eatPunct(',')) parts.push(this.parseExpr());
    this.expectPunct('}', 'to close the concatenation');
    return { kind: 'Concat', parts, span: this.spanFrom(start) };
  }

  private parseExprList(): A.Expr[] {
    const list = [this.parseExpr()];
    while (this.eatPunct(',')) list.push(this.parseExpr());
    return list;
  }

  /**
   * An assignment target: identifier with optional selects, or a concatenation
   * of those (`{carry, sum} = a + b;`). Deliberately *not* a full expression —
   * see parseProceduralAssign for why.
   */
  private parseLValue(): A.Expr {
    const t = this.tok;
    if (this.eatPunct('{')) {
      const parts: A.Expr[] = [];
      do parts.push(this.parseLValue());
      while (this.eatPunct(','));
      this.expectPunct('}', 'to close the concatenation on the left-hand side');
      return { kind: 'Concat', parts, span: this.spanFrom(t) };
    }
    if (t.kind !== 'ident') this.fail('expected an assignment target (a name, bit select or {concatenation})');
    this.next();
    if (this.isPunct('.')) {
      this.failAt(`assigning through a hierarchical name ('${t.text}.…') is not supported`, t.span);
    }
    return this.parsePostfix({ kind: 'Ident', name: t.text, span: t.span });
  }
}
