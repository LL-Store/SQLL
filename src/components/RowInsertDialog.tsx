/**
 * 新增一行弹窗：按字段生成表单，留空的列不写进 INSERT（交给默认值 / 自增）。
 * SQL 预览带防抖，输入过程中实时更新。
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/services/ipc';
import type { ColumnMeta, NodeRef, KeyValue } from '@/types';
import s from './RowInsertDialog.module.css';

interface Props {
  open: boolean;
  title: string;
  connId: string;
  node: NodeRef;
  columns: ColumnMeta[];
  production?: boolean;
  onClose: () => void;
  onDone: (sql: string, applied: number) => void;
}

/** 新增一行：只填想填的列，留空的列交给数据库默认值 */
export function RowInsertDialog({
  open,
  title,
  connId,
  node,
  columns,
  production = false,
  onClose,
  onDone,
}: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [sql, setSql] = useState('');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValues({});
      setSql('');
      setError(null);
      setPreviewError(null);
      setAck(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !applying) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, applying, onClose]);

  const payload = useMemo<KeyValue[]>(
    () =>
      Object.entries(values)
        .filter(([, v]) => v !== '')
        .map(([column, value]) => ({ column, value })),
    [values],
  );

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      api
        .insertPreview(connId, node, payload)
        .then((r) => {
          if (!alive) return;
          setSql(r.sql);
          setPreviewError(null);
        })
        .catch((e) => {
          if (!alive) return;
          setPreviewError((e as Error).message);
        });
    }, 220);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [open, connId, node, payload]);

  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      const r = await api.insertApply(connId, node, payload);
      onDone(r.sql, r.applied ?? 0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  if (!open) return null;

  return (
    <div className={s.mask} onMouseDown={(e) => e.target === e.currentTarget && !applying && onClose()}>
      <div className={s.card} role="dialog" aria-modal="true">
        <div className={s.head}>
          <div className={s.title}>新增一行</div>
          <div className={s.sub}>
            {title} · 留空的列使用数据库默认值
            {production ? <span className={s.prod}>生产连接</span> : null}
          </div>
        </div>

        <div className={s.body}>
          <div className={s.fields}>
            {columns.map((c) => (
              <label className={s.field} key={c.name}>
                <div className={s.fieldHead}>
                  <span className={c.primaryKey ? `${s.name} ${s.pk}` : s.name}>{c.name}</span>
                  <span className={s.type}>{c.typeName}</span>
                </div>
                <input
                  className={s.input}
                  value={values[c.name] ?? ''}
                  placeholder={
                    c.defaultValue
                      ? `留空 = ${c.defaultValue}`
                      : c.nullable
                        ? '留空 = NULL'
                        : c.primaryKey
                          ? '留空 = 自增 / 默认'
                          : '留空 = NULL'
                  }
                  spellCheck={false}
                  onChange={(e) => setValues((v) => ({ ...v, [c.name]: e.target.value }))}
                />
              </label>
            ))}
          </div>

          <div className={s.previewHead}>将执行</div>
          <pre className={s.sql}>
            {previewError ? `-- ${previewError}` : sql || 'insert …'}
          </pre>
          {error ? <div className={s.err}>{error}</div> : null}
          {production ? (
            <label className={s.ack}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>这是生产连接，我已确认会真实插入线上数据</span>
            </label>
          ) : null}
        </div>

        <div className={s.foot}>
          <span className={s.tip}>空值不会被拼进 SQL，交给数据库默认值</span>
          <span className={s.spacer} />
          <button className={s.cancel} onClick={onClose} disabled={applying}>
            取消
          </button>
          <button
            className={s.ok}
            onClick={() => void apply()}
            disabled={applying || !!previewError || (production && !ack)}
          >
            {applying ? '写入中…' : '插入这一行'}
          </button>
        </div>
      </div>
    </div>
  );
}
