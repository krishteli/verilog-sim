# CLAUDE.md

Guidance for Claude (and humans) working in this repo.

## What this is

A browser-based Verilog simulator and visualizer, built as a resume project.
The author must be able to explain every part of it in an interview, so
**explain non-obvious design decisions** in commit messages, code comments,
and chat — favour clarity over cleverness.

Stack: TypeScript, React, Vite, Monaco Editor, Canvas (waveforms), elkjs
(schematics), Vitest. Deploys as a static site (GitHub Pages via
`.github/workflows/deploy.yml`, or Vercel).

## Pipeline

```
source text
  -> lexer        src/core/lexer      Token[]
  -> parser       src/core/parser     AST (recursive descent, hand-written)
  -> elaborator   src/core/elab       Netlist: flat signals, sized exprs, processes
  -> simulator    src/core/sim        event-driven, 2-state, generators per process
  -> outputs      src/core/vcd.ts     VCD export; SimResult.waves for the viewer
  -> board        src/core/board      virtual Basys 3 driving a SimSession
  -> schematic    src/core/schematic  per-instance block diagram (layout: elkjs in the UI)
  -> UI           src/ui              Monaco, Web Worker, canvas waveform viewer
```

Entry point for everything: `src/core/index.ts` (`compile`, `run`).

`src/core/**` must stay **pure TypeScript with no DOM or React imports**, so
it runs under Vitest in Node, in CI, and in the Web Worker.

## Correctness reference: Icarus Verilog

Our simulator's printed output must match Icarus exactly for every golden
design (`tests/golden/*.v`, or `*.files` listing sources elsewhere such as
`boards/basys3/`). When behaviour is unclear, **write a tiny probe design and
run it under `iverilog`/`vvp`** instead of guessing; then pin the result with
a golden design or unit test. After changing a golden design run
`scripts/update-golden.sh` (needs `iverilog` on PATH; on this Windows machine
it's in `C:\iverilog\bin`).

Known, intentional differences (keep README in sync): 2-state values (X shows
as 0, but first writes still behave as X->value events); divide by zero is 0;
`` `timescale `` ignored.

## Supported Verilog subset

See README "Verilog subset". Anything outside it must produce a **clear
diagnostic with a line:column**, never a crash or silent misparse.

## Conventions

- Every source location is a `Span` (`start`/`end` offsets plus 1-based
  `line`/`col`). Errors are `VerilogError`s carrying a `Span`.
- Tests live next to the code (`foo.ts` + `foo.test.ts`); golden tests in `tests/`.
- AST and netlist are plain data (discriminated unions on `kind`/`k`), no
  classes or closures, so they serialize and cross the worker boundary.
- Values are canonical unsigned `bigint`s; signedness is applied only where an
  operation needs it (see `src/core/bits.ts`).
- Keep commits small, one concern each, Conventional Commit prefixes
  (`feat(sim):`, `fix(elab):`, `test:`, `ci:`, `docs:`). The body explains *why*.

## Commands

```bash
npm run dev        # Vite dev server
npm test           # Vitest: unit + golden tests
npm run typecheck
npm run build      # typecheck + production build into dist/
bash scripts/update-golden.sh   # regenerate golden .expected files with Icarus
```

## Milestones

1. Lexer and parser with unit tests — done
2. Elaboration + combinational logic — done
3. Event-driven simulation (clocked logic, NBA, delays) — done
4. Waveform viewer (zoom/pan, radix, VCD export) — done
5. Schematic view from the netlist (elkjs) — done
6. Examples, shareable URLs, deployment — done except the README demo GIF
Stretch: virtual Basys 3 board panel — done (`src/core/board`, `src/ui/BoardPanel.tsx`).
A real-board flow (Vivado + XDC, or `build.tcl`) is in `boards/basys3/`; the
demo is verified on real hardware.

CI: `.github/workflows/ci.yml` runs typecheck, tests (incl. golden) and build,
plus a job that regenerates golden outputs with a real `iverilog` and fails on
any diff.
