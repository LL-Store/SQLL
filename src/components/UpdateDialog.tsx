/**
 * 单元格编辑的确认弹窗：展示将要执行的 UPDATE，生产连接需额外勾选确认。
 */

import { useEffect, useState } from 'react';
import s from './UpdateDialog.module.css';

interface Props {
  open: boolean;
  title: string;
  column: string;
  sql: string;
  applying: boolean;
  production?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function UpdateDialog({
  open,
  title,
  column,
  sql,
  applying,
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
          <div className={s.title}>修改单元格</div>
          <div className={s.sub}>
            {title} · 字段 {column}
            {production ? <span className={s.prodTag}>生产连接</span> : null}
          </div>
        </div>
        <div className={s.body}>
          <div className={s.label}>将执行以下语句（单条事务，影响 1 行内）</div>
          <pre className={s.sql}>{sql}</pre>
          {production ? (
            <label className={s.ack}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>这是生产连接，我已确认该语句会真实写入线上数据</span>
            </label>
          ) : null}
          <p className={s.hint}>执行前请确认条件与写入值；「清空输入框」表示写入 NULL。</p>
        </div>
        <div className={s.foot}>
          <button className={s.cancel} onClick={onCancel} disabled={applying}>
            取消
          </button>
          <button
            className={s.ok}
            onClick={onConfirm}
            disabled={applying || (production && !ack)}
          >
            {applying ? '执行中…' : production ? '确认写入生产库' : '确认执行'}
          </button>
        </div>
      </div>
    </div>
  );
}
