/**
 * CodeMirror 6 的 SQL 编辑器。
 *
 * 方言与补全 schema 放在 `Compartment` 里，切换时只热替换语言扩展，
 * 不重建 EditorView——重建会丢光标位置和 undo 历史。
 * 主题颜色全部走 CSS 变量，因此切深浅色时编辑器不用重配。
 */

import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { sql, PostgreSQL, MySQL, SQLite } from '@codemirror/lang-sql';
import s from './SqlEditor.module.css';

interface TableSchema {
  name: string;
  columns: string[];
}

interface Props {
  value: string;
  dialect?: string;
  onChange: (value: string) => void;
  onRun: () => void;
  fontSize?: number;
  /** 当前表结构，用于表名 / 字段名自动补全 */
  tables?: TableSchema[];
}

// 语言扩展按方言 + 整库表结构生成：schema 传全库，写 join 时另一张表的字段也能补。
function langExt(dialect: string | undefined, tables?: TableSchema[]) {
  const lang = dialect === 'mysql' ? MySQL : dialect === 'sqlite' ? SQLite : PostgreSQL;
  const schema = tables?.length
    ? Object.fromEntries(tables.map((t) => [t.name, t.columns]))
    : undefined;
  return sql({ dialect: lang, schema, upperCaseKeywords: true });
}

function makeTheme(fontSize: number) {
  return EditorView.theme({
  '&': {
    fontSize: `${fontSize}px`,
    color: 'var(--text)',
    backgroundColor: 'var(--bg)',
  },
  '.cm-content': {
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    padding: '6px 0',
    caretColor: 'var(--accent)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--panel-2)',
    color: 'var(--muted-2)',
    border: 'none',
    borderRight: '1px solid var(--line-2)',
    fontSize: '10.5px',
  },
  '.cm-activeLine': { backgroundColor: 'var(--accent-soft)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--accent-soft)', color: 'var(--sel-text)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--sel) !important',
  },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  });
}

export function SqlEditor({ value, dialect, onChange, onRun, fontSize = 12, tables }: Props) {
  const langSlot = useRef(new Compartment());
  const schemaKey = `${dialect ?? ''}|${JSON.stringify(tables ?? [])}`;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);

  onChangeRef.current = onChange;
  onRunRef.current = onRun;

  useEffect(() => {
    if (!view.current) return;
    // 只重配语言扩展，不重建 EditorView：重建会丢光标与 undo 历史
    view.current.dispatch({
      effects: langSlot.current.reconfigure(langExt(dialect, tables)),
    });
    // schemaKey 覆盖 dialect 与表结构变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKey]);

  useEffect(() => {
    if (!host.current) return;
    const update = EditorView.updateListener.of((u) => {
      if (u.docChanged) onChangeRef.current(u.state.doc.toString());
    });
    const runKey = keymap.of([
      {
        key: 'Mod-Enter',
        run: () => {
          onRunRef.current();
          return true;
        },
      },
    ]);
    view.current = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          langSlot.current.of(langExt(dialect, tables)),
          makeTheme(fontSize),
          update,
          runKey,
          EditorView.lineWrapping,
        ],
      }),
      parent: host.current,
    });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
    // 只在下标/字号变化时重建，正文内容由下面的 effect 同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialect, fontSize]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (value !== v.state.doc.toString()) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} className={s.host} />;
}
