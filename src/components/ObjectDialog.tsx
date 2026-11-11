/**
 * 视图 / 函数 / 存储过程 / 触发器的定义查看弹窗（定义由后端按方言取回）。
 */

import { useEffect } from 'react';
import { useAppStore } from '@/store';
import s from './ObjectDialog.module.css';

const KIND_LABEL: Record<string, string> = {
  view: '视图',
  function: '函数',
  procedure: '存储过程',
  trigger: '触发器',
};

/** 函数 / 存储过程 / 触发器 / 视图的定义查看 */
export function ObjectDialog() {
  const info = useAppStore((st) => st.objectInfo);
  const close = useAppStore((st) => st.closeObject);

  useEffect(() => {
    if (!info) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [info, close]);

  if (!info) return null;

  const copy = () => {
    void navigator.clipboard.writeText(info.sql);
    useAppStore.getState().notify('定义已复制');
  };

  return (
    <div className={s.mask} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={s.card} role="dialog" aria-modal="true">
        <div className={s.head}>
          <div className={s.title}>{info.title}</div>
          <div className={s.sub}>{KIND_LABEL[info.kind] ?? info.kind} 定义</div>
        </div>
        <div className={s.body}>
          {info.loading ? (
            <div className={s.state}>正在读取定义…</div>
          ) : info.error ? (
            <div className={s.err}>{info.error}</div>
          ) : (
            <pre className={s.code}>{info.sql}</pre>
          )}
        </div>
        <div className={s.foot}>
          <span className={s.tip}>只读展示，来自数据库自身保存的定义</span>
          <span className={s.spacer} />
          <button className={s.ghost} onClick={close}>
            关闭
          </button>
          <button className={s.primary} onClick={copy} disabled={!info.sql}>
            复制定义
          </button>
        </div>
      </div>
    </div>
  );
}
