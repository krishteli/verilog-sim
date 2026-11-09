/**
 * Monaco setup. This module is loaded lazily (dynamic import from Editor.tsx)
 * because Monaco is by far the largest dependency; the rest of the page can
 * paint before it arrives.
 */
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { KEYWORDS } from '../core/lexer/token';

// Monaco offloads work like diffing to a web worker. We only use the base
// editor worker; no TypeScript/JSON language services are needed.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export const LANGUAGE_ID = 'verilog-subset';

monaco.languages.register({ id: LANGUAGE_ID, extensions: ['.v'] });

monaco.languages.setLanguageConfiguration(LANGUAGE_ID, {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
    ['begin', 'end'],
    ['case', 'endcase'],
    ['module', 'endmodule'],
  ],
  autoClosingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '{', close: '}' },
    { open: '"', close: '"', notIn: ['string'] },
  ],
});

// Syntax highlighting with Monaco's Monarch tokenizer. The keyword list is
// the lexer's own, so highlighting and parsing never disagree about what's
// reserved.
monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, {
  keywords: [...KEYWORDS],
  tokenizer: {
    root: [
      [/\$[a-zA-Z_][\w$]*/, 'predefined'],
      [/`[a-zA-Z_]\w*/, 'annotation'],
      [/[a-zA-Z_][\w$]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
      [/\d[\d_]*\s*'[sS]?[bBoOdDhH]\s*[0-9a-fA-FxXzZ_?]+/, 'number'],
      [/'[sS]?[bBoOdDhH]\s*[0-9a-fA-FxXzZ_?]+/, 'number'],
      [/\d[\d_]*/, 'number'],
      [/"/, 'string', '@string'],
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      [/[{}()[\]]/, '@brackets'],
      [/[;,.]/, 'delimiter'],
      [/[=<>!~?:&|+\-*/^%#@]+/, 'operator'],
    ],
    comment: [
      [/[^*/]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[*/]/, 'comment'],
    ],
    string: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string', '@pop'],
    ],
  },
});

monaco.editor.defineTheme('vsim-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '7c3aed' },
    { token: 'predefined', foreground: '0e7490' },
    { token: 'number', foreground: 'b45309' },
    { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
  ],
  colors: { 'editor.background': '#fbfbfa' },
});

monaco.editor.defineTheme('vsim-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: 'c4b5fd' },
    { token: 'predefined', foreground: '67e8f9' },
    { token: 'number', foreground: 'fbbf24' },
    { token: 'comment', foreground: '8b93a1', fontStyle: 'italic' },
  ],
  colors: { 'editor.background': '#16181d' },
});

export { monaco };
