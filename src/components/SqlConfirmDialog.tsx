/**
 * 通用「先看 SQL 再确认」弹窗，删除单行 / 批量删除 / 新增行共用。
 * 与 UpdateDialog 共用样式，`danger` 用于删除类操作。
 */

import { useEffect, useState } from 'react';
import s from './UpdateDialog.module.css';

interface Props {
  open: boolean;
  title: string;
  subtitle?: string;
  hint?: string;
  sql: string;
  applying: boolean;
  danger?: boolean;
  production?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** 通用「先看 SQL 再确认」弹窗：新增行、删除行复用 */
export function SqlConfirmDialog({
  open,
  title,
  subtitle,
  hint,
  sql,
  applying,
  danger = false,
  production = false,
  onCancel,
  onConfirm,
}: Props) {
  const [ack, setAck] = useState(false);

  useEffect(() => {
    if (open) setAck(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !applying) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, applying, onCancel]);

  if (!open) return null;

  return (
    <div className={s.mask} onMouseDown={(e) => e.target === e.currentTarget && !applying && onCancel()}>
      <div className={s.card} role="dialog" aria-modal="true">
        <div className={s.head}>
          <div className={s.title}>{title}</div>
          <div className={s.sub}>
            {subtitle}
            {production ? <span className={s.prodTag}>生产连接</span> : null}
          </div>
        </div>
        <div className={s.body}>
          <div className={s.label}>将执行以下语句</div>
          <pre className={s.sql}>{sql}</pre>
          {production ? (
            <label className={s.ack}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>这是生产连接，我已确认该语句会真实写入线上数据</span>
            </label>
          ) : null}
          {hint ? <p className={s.hint}>{hint}</p> : null}
        </div>
        <div className={s.foot}>
          <button className={s.cancel} onClick={onCancel} disabled={applying}>
            取消
          </button>
          <button
            className={danger ? `${s.ok} ${s.danger}` : s.ok}
            onClick={onConfirm}
            disabled={applying || (production && !ack)}
          >
            {applying ? '执行中…' : danger ? '确认删除' : '确认写入'}
          </button>
        </div>
      </div>
    </div>
  );
}
