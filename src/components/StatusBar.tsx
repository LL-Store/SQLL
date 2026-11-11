/**
 * 底部状态栏：连接状态、当前表、分页与总行数、版本号。
 * 分页控件放在这里，和数据网格底部保持同一视觉基线。
 */

import { APP_VERSION } from '@/types';
import { useAppStore } from '@/store';
import s from './StatusBar.module.css';

export function StatusBar() {
  const st = useAppStore();
  const active = st.tabs.find((t) => t.key === st.activeKey) ?? null;

  return (
    <footer className={s.bar}>
      <span className={s.dot} style={{ background: active ? '#2fb344' : '#c9ced6' }} />
      <span className={active ? s.state : s.idle}>{active ? '已连接' : '就绪'}</span>
      <span className={s.sep} />
      <span className={s.hint}>
        {active ? `${active.connName} · ${active.title}` : '未连接数据库'}
      </span>
      {st.tabs.length > 1 ? <span className={s.count}>{st.tabs.length} 个标签</span> : null}

      {active ? (
        <>
          <span className={s.spacer} />
          <button
            className={s.pageBtn}
            onClick={() => void st.loadPage(Math.max(0, active.page - 1))}
            disabled={active.page === 0}
            aria-label="上一页"
          >
            ‹
          </button>
          <span className={s.pageNo}>第 {active.page + 1} 页</span>
          <button
            className={s.pageBtn}
            onClick={() => void st.loadPage(active.page + 1)}
            disabled={!active.result || active.result.rows.length < active.pageSize}
            aria-label="下一页"
          >
            ›
          </button>
          <span className={s.sep} />
          <select
            className={s.size}
            value={active.pageSize}
            onChange={(e) => void st.setPageSize(Number(e.target.value))}
          >
            <option value={50}>50 行/页</option>
            <option value={100}>100 行/页</option>
            <option value={200}>200 行/页</option>
          </select>
        </>
      ) : null}

      {active?.result?.total !== null && active?.result?.total !== undefined ? (
        <span className={s.total}>共 {active.result.total} 行</span>
      ) : null}
      <span className={s.version} title="版本号来自 package.json 的 version 字段">
        v{APP_VERSION}
      </span>
    </footer>
  );
}
