/**
 * Abstract syntax tree for the supported Verilog subset.
 *
 * Design choices:
 * - Plain objects discriminated by `kind`, not classes. They serialize to JSON
 *   as-is (handy for snapshot tests and for posting to a Web Worker), and a
 *   `switch (node.kind)` gives exhaustive type-checked handling in later passes.
 * - Every node has a `span`, so the elaborator and simulator can report errors
 *   at the right place in the source.
 * - The AST mirrors the *syntax*. Semantic questions (is this name declared?
 *   how wide is this expression?) are left to the elaborator.
 */
import type { Span } from '../diagnostics';
import type { NumberValue } from '../lexer/token';

export interface SourceFile {
  kind: 'SourceFile';
  modules: ModuleDecl[];
  span: Span;
}

export interface ModuleDecl {
  kind: 'Module';
  name: string;
  /** From the `#(parameter ...)` header list. */
  params: ParamDecl[];
  ports: PortDecl[];
  items: ModuleItem[];
  span: Span;
}

/** `[msb:lsb]`. Bounds are expressions because they often use parameters, e.g. `[W-1:0]`. */
export interface Range {
  msb: Expr;
  lsb: Expr;
  span: Span;
}

export type Direction = 'input' | 'output' | 'inout';
export type NetType = 'wire' | 'reg' | 'integer';

/**
 * One port from an ANSI port list. `input [7:0] a, b` produces two PortDecls
 * that share direction/type/range — flattening here saves every later pass
 * from handling the grouped form.
 */
export interface PortDecl {
  kind: 'Port';
  direction: Direction;
  netType: NetType;
  signed: boolean;
  range: Range | null;
  name: string;
  span: Span;
}

// ---- module items -----------------------------------------------------------

export type ModuleItem = NetDecl | ParamDecl | ContinuousAssign | AlwaysBlock | InitialBlock | Instance;

export interface NetDecl {
  kind: 'NetDecl';
  netType: NetType;
  signed: boolean;
  range: Range | null;
  declarators: Declarator[];
  span: Span;
}

/** One name in a declaration, with an optional initializer: the `b = 1` in `reg a, b = 1;`. */
export interface Declarator {
  name: string;
  init: Expr | null;
  span: Span;
}

export interface ParamDecl {
  kind: 'ParamDecl';
  /** `localparam` cannot be overridden from an instantiation. */
  local: boolean;
  signed: boolean;
  range: Range | null;
  assignments: ParamAssignment[];
  span: Span;
}

export interface ParamAssignment {
  name: string;
  value: Expr;
  span: Span;
}

export interface ContinuousAssign {
  kind: 'ContinuousAssign';
  assignments: { lhs: Expr; rhs: Expr; span: Span }[];
  span: Span;
}

/**
 * `always <stmt>`. Note there is no special "always @(...)" node: in Verilog,
 * `always` just means "repeat this statement forever", and `@(posedge clk)` is
 * an ordinary timing control on that statement. So `always @(posedge clk) q <= d;`
 * is an AlwaysBlock whose body is an EventControl statement. This also covers
 * testbench idioms like `always #5 clk = ~clk;` with no extra cases.
 */
export interface AlwaysBlock {
  kind: 'Always';
  body: Stmt;
  span: Span;
}

export interface InitialBlock {
  kind: 'Initial';
  body: Stmt;
  span: Span;
}

/** `counter #(.W(8)) u0 (.clk(clk), .q(count));` */
export interface Instance {
  kind: 'Instance';
  moduleName: string;
  instanceName: string;
  paramOverrides: Connection[];
  connections: Connection[];
  span: Span;
}

export type Connection =
  | { kind: 'Named'; name: string; expr: Expr | null; span: Span } // `.q()` leaves a port unconnected
  | { kind: 'Positional'; expr: Expr; span: Span };

// ---- statements -------------------------------------------------------------

export type Stmt = Block | If | Case | ProceduralAssign | Delay | EventControl | SystemTaskCall | NullStmt;

export interface Block {
  kind: 'Block';
  /** `begin : name` */
  name: string | null;
  stmts: Stmt[];
  span: Span;
}

export interface If {
  kind: 'If';
  cond: Expr;
  then: Stmt;
  else: Stmt | null;
  span: Span;
}

export interface Case {
  kind: 'Case';
  subject: Expr;
  items: CaseItem[];
  default: Stmt | null;
  span: Span;
}

export interface CaseItem {
  labels: Expr[];
  body: Stmt;
  span: Span;
}

/**
 * Blocking (`=`) and nonblocking (`<=`) assignment share one node because they
 * have identical syntax; only the simulator treats them differently (blocking
 * updates immediately, nonblocking is deferred to the end of the time step).
 */
export interface ProceduralAssign {
  kind: 'ProceduralAssign';
  blocking: boolean;
  lhs: Expr;
  rhs: Expr;
  span: Span;
}

/** `#10 stmt` or `#10;`. */
export interface Delay {
  kind: 'Delay';
  amount: Expr;
  body: Stmt | null;
  span: Span;
}

/** `@(posedge clk) stmt`, `@(*) stmt`, or `@(posedge clk);`. */
export interface EventControl {
  kind: 'EventControl';
  sensitivity: Sensitivity;
  body: Stmt | null;
  span: Span;
}

export type Sensitivity = { kind: 'Star'; span: Span } | { kind: 'List'; items: SensitivityItem[]; span: Span };

export interface SensitivityItem {
  edge: 'posedge' | 'negedge' | null;
  signal: Expr;
  span: Span;
}

export interface SystemTaskCall {
  kind: 'SystemTaskCall';
  name: string;
  args: Expr[];
  span: Span;
}

export interface NullStmt {
  kind: 'Null';
  span: Span;
}

// ---- expressions ------------------------------------------------------------

export type Expr =
  | Ident
  | NumberLit
  | StringLit
  | Unary
  | Binary
  | Ternary
  | Index
  | RangeSelect
  | PartSelect
  | Concat
  | Replicate
  | SystemCall;

export interface Ident {
  kind: 'Ident';
  name: string;
  span: Span;
}

export interface NumberLit {
  kind: 'Number';
  value: NumberValue;
  span: Span;
}

/** Only meaningful as a system task argument, e.g. `$display("q=%d", q)`. */
export interface StringLit {
  kind: 'String';
  value: string;
  span: Span;
}

export type UnaryOp = '+' | '-' | '!' | '~' | '&' | '|' | '^' | '~&' | '~|' | '~^' | '^~';

export interface Unary {
  kind: 'Unary';
  op: UnaryOp;
  operand: Expr;
  span: Span;
}

export type BinaryOp =
  | '||' | '&&'
  | '|' | '^' | '~^' | '^~' | '&'
  | '==' | '!=' | '===' | '!=='
  | '<' | '<=' | '>' | '>='
  | '<<' | '>>' | '<<<' | '>>>'
  | '+' | '-' | '*' | '/' | '%' | '**';

export interface Binary {
  kind: 'Binary';
  op: BinaryOp;
  left: Expr;
  right: Expr;
  span: Span;
}

export interface Ternary {
  kind: 'Ternary';
  cond: Expr;
  then: Expr;
  else: Expr;
  span: Span;
}

/** `a[i]` — a single bit. */
export interface Index {
  kind: 'Index';
  target: Expr;
  index: Expr;
  span: Span;
}

/** `a[7:4]` — constant bounds. */
export interface RangeSelect {
  kind: 'RangeSelect';
  target: Expr;
  msb: Expr;
  lsb: Expr;
  span: Span;
}

/** `a[base +: width]` / `a[base -: width]` — variable base, constant width. */
export interface PartSelect {
  kind: 'PartSelect';
  target: Expr;
  base: Expr;
  dir: '+:' | '-:';
  width: Expr;
  span: Span;
}

/** `{a, b, 4'b0}` */
export interface Concat {
  kind: 'Concat';
  parts: Expr[];
  span: Span;
}

/** `{4{a}}` / `{2{a, b}}` */
export interface Replicate {
  kind: 'Replicate';
  count: Expr;
  parts: Expr[];
  span: Span;
}

/** A system function used as a value, e.g. `$time`. */
export interface SystemCall {
  kind: 'SystemCall';
  name: string;
  args: Expr[];
  span: Span;
}
