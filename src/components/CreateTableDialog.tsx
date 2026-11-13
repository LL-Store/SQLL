/**
 * 新增表弹窗：填表名 + 若干列（列名 / 类型 / 是否可空 / 主键 / 注释），
 * 实时把 CREATE TABLE 拼出来预览；确认后调用后端建表。
 *
 * 类型文本由用户按当前方言填写（如 int / varchar(64) / bigint / text），
 * 后端只做标识符转义与列定义校验，不擅自改写类型。
 */

import { useEffect, useMemo, useState } from 'react';
import { api, errMessage } from '@/services/ipc';
import { useAppStore } from '@/store';
import type { DbKind, NewColumn, NodeRef } from '@/types';
import s from './CreateTableDialog.module.css';

interface Props {
  open: boolean;
  connId: string;
  node: NodeRef;
  scopeLabel: string;
  production?: boolean;
  onClose: () => void;
  onDone: () => void;
}

interface DraftCol {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  comment: string;
}

/** 各方言常用列类型建议；仍允许在输入框里手填任意类型。 */
const TYPE_SUGGESTIONS: Record<DbKind, string[]> = {
  mysql: [
    'int',
    'bigint',
    'smallint',
    'tinyint',
    'varchar(64)',
    'varchar(255)',
    'text',
    'decimal(10,2)',
    'datetime',
    'timestamp',
    'date',
    'boolean',
    'json',
  ],
  postgres: [
    'integer',
    'bigint',
    'smallint',
    'varchar(64)',
    'text',
    'numeric(10,2)',
    'timestamp',
    'date',
    'boolean',
    'jsonb',
  ],
  sqlite: ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB', 'BOOLEAN', 'DATETIME'],
};

function emptyCol(): DraftCol {
  return { name: '', dataType: '', nullable: true, primaryKey: false, comment: '' };
}

export function CreateTableDialog({ open, connId, node, scopeLabel, production = false, onClose, onDone }: Props) {
  const connKind = useAppStore((st) => st.connections.find((c) => c.id === connId)?.kind ?? 'mysql');
  const typeSuggestions = TYPE_SUGGESTIONS[connKind] ?? TYPE_SUGGESTIONS.mysql;
  const [tableName, setTableName] = useState('');
  const [cols, setCols] = useState<DraftCol[]>([emptyCol()]);
  const [sql, setSql] = useState('');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTableName('');
      setCols([emptyCol()]);
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

  // 本地校验：把漏列名 / 漏类型 / 重名等问题在预览前暴露出来，避免静默丢弃整列。
  const localError = useMemo<string | null>(() => {
    const named = cols.filter((c) => c.name.trim() !== '');
    if (cols.some((c) => c.name.trim() === '' && c.dataType.trim() !== '')) {
      return '存在已填类型但未填写列名的列，请补全列名或删除该列。';
    }
    if (named.some((c) => c.dataType.trim() === '')) {
      return '存在未填写类型的列，请为每一列选择或输入类型。';
    }
    const lower = named.map((c) => c.name.trim().toLowerCase());
    if (lower.length !== new Set(lower).size) {
      return '列名存在重复，请检查后再创建。';
    }
    return null;
  }, [cols]);

  const payload = useMemo<NewColumn[]>(
    () =>
      cols
        .filter((c) => c.name.trim() !== '' && c.dataType.trim() !== '')
        .map((c) => ({
          name: c.name.trim(),
          dataType: c.dataType.trim(),
          nullable: c.nullable,
          primaryKey: c.primaryKey,
          comment: c.comment.trim() || null,
        })),
    [cols],
  );

  // 实时预览：把表名 + 列定义发给后端按方言拼 CREATE TABLE（不执行）
  useEffect(() => {
    if (!open) return;
    if (localError) {
      setSql('');
      setPreviewError(localError);
      return;
    }
    if (!tableName.trim() || payload.length === 0) {
      setSql('');
      setPreviewError(null);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      api
        .createTablePreview(connId, node, tableName.trim(), payload)
        .then((r) => {
          if (!alive) return;
          setSql(r.sql);
          setPreviewError(null);
        })
        .catch((e) => {
          if (!alive) return;
          setPreviewError(errMessage(e));
        });
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [open, connId, node, tableName, payload, localError]);

  const setCol = (idx: number, patch: Partial<DraftCol>) =>
    setCols((list) => list.map((c, i) => (i === idx ? { ...c, ...patch } : c)));

  const removeCol = (idx: number) => setCols((list) => list.filter((_, i) => i !== idx));

  const apply = async () => {
    setApplying(true);
    setError(null);
    try {
      await api.createTable(connId, node, tableName.trim(), payload);
      onDone();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setApplying(false);
    }
  };

  if (!open) return null;

  const canSubmit =
    !!tableName.trim() &&
    payload.length > 0 &&
    !localError &&
    !previewError &&
    !applying &&
    (!production || ack);

  return (
    <div className={s.mask} onMouseDown={(e) => e.target === e.currentTarget && !applying && onClose()}>
      <div className={s.card} role="dialog" aria-modal="true">
        <div className={s.head}>
          <div className={s.title}>新增表</div>
          <div className={s.sub}>
            {scopeLabel} · 类型可下拉选择常用项，也可自定义输入
            {production ? <span className={s.prod}>生产连接</span> : null}
          </div>
        </div>

        <div className={s.body}>
          <label className={s.tableNameRow}>
            <span className={s.name}>表名</span>
            <input
              className={s.input}
              value={tableName}
              placeholder="例如 orders"
              spellCheck={false}
              onChange={(e) => setTableName(e.target.value)}
            />
          </label>

          <div className={s.colHead}>
            <span>列定义</span>
            <button type="button" className={s.addCol} onClick={() => setCols((l) => [...l, emptyCol()])}>
              + 添加列
            </button>
          </div>

          <datalist id="sqll-type-suggestions">
            {typeSuggestions.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>

          <div className={s.cols}>
            {cols.map((c, idx) => (
              <div className={s.col} key={idx}>
                <input
                  className={s.input}
                  placeholder="列名"
                  spellCheck={false}
                  value={c.name}
                  onChange={(e) => setCol(idx, { name: e.target.value })}
                />
                <input
                  className={s.input}
                  placeholder="类型"
                  spellCheck={false}
                  list="sqll-type-suggestions"
                  title="可下拉选择常用类型，也可直接输入自定义类型"
                  value={c.dataType}
                  onChange={(e) => setCol(idx, { dataType: e.target.value })}
                />
                <label className={s.flag}>
                  <input
                    type="checkbox"
                    checked={!c.nullable}
                    onChange={(e) => setCol(idx, { nullable: !e.target.checked })}
                  />
                  <span>非空</span>
                </label>
                <label className={s.flag}>
                  <input
                    type="checkbox"
                    checked={c.primaryKey}
                    onChange={(e) => setCol(idx, { primaryKey: e.target.checked })}
                  />
                  <span>主键</span>
                </label>
                <button
                  type="button"
                  className={s.delCol}
                  onClick={() => removeCol(idx)}
                  disabled={cols.length <= 1}
                  aria-label="删除这一列"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <div className={s.previewHead}>将执行</div>
          <pre className={s.sql}>{previewError ? `-- ${previewError}` : sql || 'CREATE TABLE …'}</pre>
          {error ? <div className={s.err}>{error}</div> : null}
          {production ? (
            <label className={s.ack}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>这是生产连接，我已确认会真实创建线上表结构</span>
            </label>
          ) : null}
        </div>

        <div className={s.foot}>
          <span className={s.tip}>主键会在表级声明；注释仅 MySQL 写入</span>
          <span className={s.spacer} />
          <button className={s.cancel} onClick={onClose} disabled={applying}>
            取消
          </button>
          <button className={s.ok} onClick={() => void apply()} disabled={!canSubmit}>
            {applying ? '创建中…' : '创建表'}
          </button>
        </div>
      </div>
    </div>
  );
}
