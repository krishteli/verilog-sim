import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import type { Span } from '../core';

type MonacoModule = typeof import('./monaco');

interface Props {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  error: { message: string; span: Span | null } | null;
  /** Bumped by the parent to move the cursor to the error. */
  revealToken: number;
  /** Select this source range (e.g. a block clicked in the schematic); `token` changes on every request. */
  select?: { span: Span; token: number } | null;
}

const darkQuery = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

/**
 * Monaco wrapper. Monaco is imperative (you create an editor object and call
 * methods on it), while React is declarative, so this component keeps the
 * editor in a ref and syncs props into it with effects.
 */
export function Editor({ value, onChange, onRun, error, revealToken, select }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const mod = useRef<MonacoModule | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Latest callbacks, so the editor's listeners (registered once) never go stale.
  const cb = useRef({ onChange, onRun });
  cb.current = { onChange, onRun };

  useEffect(() => {
    let disposed = false;
    void import('./monaco').then((m) => {
      if (disposed || !host.current) return;
      mod.current = m;
      const { monaco, LANGUAGE_ID } = m;
      const editor = monaco.editor.create(host.current, {
        value,
        language: LANGUAGE_ID,
        theme: darkQuery?.matches ? 'vsim-dark' : 'vsim-light',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        scrollBeyondLastLine: false,
        tabSize: 2,
        renderLineHighlight: 'line',
        padding: { top: 8 },
        // Otherwise Monaco reads delays like `#200` as CSS colours and draws swatches.
        colorDecorators: false,
      });
      editor.onDidChangeModelContent(() => cb.current.onChange(editor.getValue()));
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => cb.current.onRun());
      editorRef.current = editor;
      setLoaded(true);
    });
    const onScheme = () => mod.current?.monaco.editor.setTheme(darkQuery?.matches ? 'vsim-dark' : 'vsim-light');
    darkQuery?.addEventListener('change', onScheme);
    return () => {
      disposed = true;
      darkQuery?.removeEventListener('change', onScheme);
      editorRef.current?.dispose();
      editorRef.current = null;
    };
    // The editor is created once; `value` changes are synced by the next effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes (choosing an example, loading a shared link).
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value, loaded]);

  // Error squiggles.
  useEffect(() => {
    const editor = editorRef.current;
    const m = mod.current;
    const model = editor?.getModel();
    if (!editor || !m || !model) return;
    const markers: Monaco.editor.IMarkerData[] = [];
    if (error?.span) {
      const start = model.getPositionAt(error.span.start);
      const end = model.getPositionAt(Math.max(error.span.end, error.span.start + 1));
      markers.push({
        severity: m.monaco.MarkerSeverity.Error,
        message: error.message.replace(/^\d+:\d+: /, ''),
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      });
    }
    m.monaco.editor.setModelMarkers(model, 'verilog', markers);
  }, [error, loaded]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !error?.span || revealToken === 0) return;
    const pos = model.getPositionAt(error.span.start);
    editor.revealPositionInCenter(pos);
    editor.setPosition(pos);
    editor.focus();
    // Only when the user asks (revealToken changes), not on every error.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealToken]);

  useEffect(() => {
    const editor = editorRef.current;
    const m = mod.current;
    const model = editor?.getModel();
    if (!editor || !m || !model || !select) return;
    const start = model.getPositionAt(select.span.start);
    const end = model.getPositionAt(select.span.end);
    const range = new m.monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
    editor.setSelection(range);
    editor.revealRangeInCenterIfOutsideViewport(range);
    // Only when a new selection is requested.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [select?.token]);

  return (
    <div className="editor-host" ref={host} aria-label="Verilog source editor">
      {!loaded && <div className="editor-loading">Loading editor…</div>}
    </div>
  );
}
