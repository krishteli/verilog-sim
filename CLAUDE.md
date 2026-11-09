# CLAUDE.md

Guidance for Claude (and humans) working in this repo.

## What this is

A browser-based Verilog simulator and visualizer, built as a resume project.
The author must be able to explain every part of it in an interview, so
**explain non-obvious design decisions** in commit messages, code comments,
and chat — favour clarity over cleverness.

Stack: TypeScript, React, Vite, Monaco Editor, Canvas (waveforms), elkjs
(schematics), Vitest. Deploys as a static site (Vercel or GitHub Pages).

## Pipeline

```
source text
  -> lexer        src/core/lexer     Token[]
  -> parser       src/core/parser    AST (recursive descent, hand-written)
  -> elaborator   src/core/elab      flat netlist (hierarchy inlined)   [M2]
  -> simulator    src/core/sim       event-driven, 2-state             [M3]
  -> UI           src/ui             Monaco, waveform canvas, schematic [M4-5]
```

`src/core/**` must stay **pure TypeScript with no DOM or React imports**, so
it runs under Vitest in Node, in CI, and later in a Web Worker.

## Supported Verilog subset (v1)

Modules; ANSI port lists (including leading-comma style); `wire`/`reg` with
`[msb:lsb]` widths; `assign`; `always @(*)`; `always @(posedge clk)`;
`if`/`else`; `case` with `default` (no `casez`/`casex` yet); blocking (`=`) and
nonblocking (`<=`) assignment; common operators; module instantiation (named
and positional ports, `#(...)` parameter overrides parse but are not yet
elaborated); `initial` blocks with `#` delays; `$display`/`$finish`-style
system tasks parse as calls. 2-state (0/1) logic only — X/Z come later.

Anything outside the subset should produce a **clear diagnostic with a
line:column**, never a crash or silent misparse.

## Conventions

- Every source location is a `Span` (`start`/`end` byte offsets plus
  1-based `line`/`col` of the start). Errors carry a `Span`.
- Errors in the core are thrown as `VerilogError` (src/core/diagnostics.ts).
- Tests live next to the code: `foo.ts` + `foo.test.ts`.
- AST nodes are plain discriminated unions on `kind` — no classes — so they
  serialize to JSON (useful for snapshot tests and Web Worker messages).
- Keep commits small, one concern each, using Conventional Commit prefixes
  (`feat(lexer):`, `test(parser):`, `ci:`, `docs:`, `chore:`). The body
  explains *why*.

## Commands

```bash
npm run dev        # Vite dev server
npm test           # Vitest, single run
npm run test:watch
npm run typecheck
npm run build      # typecheck + production build into dist/
```

## Milestones

1. Lexer and parser with unit tests  ← current
2. Elaboration + combinational logic
3. Event-driven simulation (clocked logic, NBA, delays)
4. Waveform viewer (zoom/pan, radix, VCD export)
5. Schematic view from the netlist (elkjs)
6. Examples, shareable URLs, deployment, README with demo GIF
Stretch: virtual Basys 3 board panel.

CI (`.github/workflows/ci.yml`) runs typecheck + tests. Once the simulator
exists (M3), it will also run designs under `tests/golden/` through Icarus
Verilog and diff the output against ours.
