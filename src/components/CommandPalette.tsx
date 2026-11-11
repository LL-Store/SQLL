/**
 * ⌘K 命令面板：输入关键字过滤，回车执行当前高亮项。
 * 动作列表根据「有没有打开的表」动态变化。
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/store';
import s from './CommandPalette.module.css';

interface Action {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const st = useAppStore();
  const hasTab = !!st.activeKey;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery('');
        setActive(0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const actions = useMemo<Action[]>(() => {
    const list: Action[] = [
      { id: 'conn', label: '新建连接', hint: '打开连接配置弹窗', run: () => st.openDialog() },
      { id: 'settings', label: '设置', hint: '分页行数、编辑器字号', run: () => st.openSettings() },
    ];
    if (hasTab) {
      list.unshift(
        { id: 'sql', label: '打开 / 关闭 SQL 编辑器', hint: '⌘↵ 在编辑器内执行', run: () => st.toggleSql() },
        { id: 'refresh', label: '刷新当前表', hint: '按现有排序与筛选重新取数', run: () => void st.reloadActive() },
        { id: 'export', label: '导出当前表为 CSV', hint: '写入 ~/Downloads', run: () => void st.exportCsv() },
        {
          id: 'close',
          label: '关闭当前标签',
          hint: '其他标签不受影响',
          run: () => st.closeTab(st.activeKey as string),
        },
      );
    }
    return list;
  }, [hasTab, st]);

  const filtered = actions.filter((a) =>
    (a.label + a.hint).toLowerCase().includes(query.trim().toLowerCase()),
  );

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  if (!open) return null;

  const runAt = (i: number) => {
    const item = filtered[i];
    if (!item) return;
    setOpen(false);
    item.run();
  };

  return (
    <div className={s.mask} onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className={s.card} role="dialog" aria-modal="true" aria-label="命令面板">
        <div className={s.inputRow}>
          <span className={s.icon}>⌘K</span>
          <input
            autoFocus
            className={s.input}
            placeholder="搜索命令：刷新、SQL、导出、设置…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(filtered.length - 1, i + 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(0, i - 1));
              }
              if (e.key === 'Enter') runAt(active);
            }}
          />
        </div>
        <div className={s.list}>
          {filtered.length === 0 ? (
            <div className={s.empty}>没有匹配的命令</div>
          ) : (
            filtered.map((a, i) => (
              <button
                key={a.id}
                className={`${s.item} ${i === active ? s.itemOn : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => runAt(i)}
              >
                <span className={s.label}>{a.label}</span>
                <span className={s.hint}>{a.hint}</span>
              </button>
            ))
          )}
        </div>
        <div className={s.foot}>
          <span>↑↓ 选择 · Enter 执行 · Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
