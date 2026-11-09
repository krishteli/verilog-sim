# Verilog Sim

A Verilog simulator and visualizer that runs entirely in the browser:
write a design, simulate it, and inspect waveforms and a generated schematic.
No install and no server needed.

> Work in progress. Milestone 1 (lexer + parser) is done.

## Architecture

```
lexer -> recursive-descent parser -> AST -> elaborator -> netlist
      -> event-driven simulator -> waveform viewer + schematic view
```

All compiler and simulator code lives in `src/core/` as plain TypeScript with
no DOM dependencies, so it is unit-tested in Node and can run in a Web Worker.

## Development

```bash
npm install
npm run dev
npm test
```

## Roadmap

- [x] Lexer and parser with unit tests
- [ ] Elaboration + combinational logic
- [ ] Event-driven simulation
- [ ] Waveform viewer with VCD export
- [ ] Schematic view
- [ ] Examples, shareable URLs, deployment
- [ ] Stretch: virtual Basys 3 board
