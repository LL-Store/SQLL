/**
 * 中间工作区：标签栏、工具条、SQL 编辑器、数据网格、空状态。
 *
 * 这里集中了表格相关的交互：
 * - 单元格编辑 / 新增行 / 删除行 / 批量删除，都是「先预览 SQL，再确认执行」；
 * - 分页、排序、筛选由 store 统一发请求，本组件只维护输入框与弹窗的临时状态；
 * - 超过 200 行时开启窗口化渲染（只渲染可视区附近的行），大表也不卡。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyDbIcon, PlusIcon, TableIcon } from './Icons';
import { ContextMenu, type MenuState } from './ContextMenu';
import { SqlEditor } from './SqlEditor';
import { UpdateDialog } from './UpdateDialog';
import { RowInsertDialog } from './RowInsertDialog';
import { SqlConfirmDialog } from './SqlConfirmDialog';
import { api } from '@/services/ipc';
import { useAppStore } from '@/store';
import type { Cell, KeyValue, SchemaTable } from '@/types';
import s from './WorkArea.module.css';

function asText(c: Cell): string {
  switch (c.t) {
    case 'null':
      return 'NULL';
    case 'text':
      return c.v;
    case 'int':
    case 'float':
      return String(c.v);
    case 'bool':
      return c.v ? 'true' : 'false';
    case 'binary':
      return `BLOB ${c.v} B`;
    default:
      return '';
  }
}

function cellClass(c: Cell): string {
  switch (c.t) {
    case 'null':
      return `${s.td} ${s.null}`;
    case 'int':
    case 'float':
      return `${s.td} ${s.num}`;
    case 'bool':
      return c.v ? `${s.td} ${s.boolT}` : `${s.td} ${s.mutedCell}`;
    case 'binary':
      return `${s.td} ${s.bin}`;
    default:
      return s.td;
  }
}

export function WorkArea() {
  const st = useAppStore();
  const tabsRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [filterInput, setFilterInput] = useState('');
  const filterTimer = useRef<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [edit, setEdit] = useState<{ row: number; col: number; value: string } | null>(null);
  const [update, setUpdate] = useState<{
    sql: string;
    keys: KeyValue[];
    column: string;
    value: string | null;
    title: string;
  } | null>(null);
  const [applying, setApplying] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [del, setDel] = useState<{ sql: string; keys: KeyValue[] } | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [schemaTables, setSchemaTables] = useState<SchemaTable[]>([]);
  const [multiDel, setMultiDel] = useState<{ sql: string; rows: KeyValue[][] } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const production = !!st.connections.find((c) => c.id === active?.connId)?.production;
  const readOnly = !!st.connections.find((c) => c.id === active?.connId)?.readOnly;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);

  const active = st.tabs.find((t) => t.key === st.activeKey) ?? null;

  // 切换标签时同步筛选框内容
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const sync = () => setViewH(el.clientHeight);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setFilterInput(active?.filter ?? '');
  }, [active?.key]);

  // 标签多到装不下时，切换/新开表要把它滚进可视区，否则看起来像「没打开」
  useEffect(() => {
    const box = tabsRef.current;
    if (!box) return;
    const el = [...box.querySelectorAll<HTMLElement>('[data-tab-key]')].find(
      (n) => n.dataset.tabKey === st.activeKey,
    );
    if (!el) return;
    if (el.offsetLeft < box.scrollLeft) box.scrollLeft = el.offsetLeft;
    else if (el.offsetLeft + el.offsetWidth > box.scrollLeft + box.clientWidth) {
      box.scrollLeft = el.offsetLeft + el.offsetWidth - box.clientWidth;
    }
  }, [st.activeKey, st.tabs.length]);

  const sqlMode = !!active?.sqlResult || !!active?.sqlError;
  const columns = sqlMode ? active?.sqlResult?.columns ?? [] : active?.result?.columns ?? [];
  const rows = sqlMode ? active?.sqlResult?.rows ?? [] : active?.result?.rows ?? [];

  // 列宽按「表头 + 可视区里最长单元格」估算字符数，再换成像素并夹在 84–360 之间，
  // 避免某一列特别长把其他列挤没。
  const widths = useMemo(() => {
    return columns.map((name, i) => {
      let max = [...name].length;
      for (const row of rows) {
        const cell = row[i];
        if (!cell || cell.t === 'null') continue;
        max = Math.max(max, [...asText(cell)].length);
      }
      return Math.min(360, Math.max(84, max * 7 + 24));
    });
  }, [columns, rows]);

  const onFilterChange = (value: string) => {
    setFilterInput(value);
    if (filterTimer.current) window.clearTimeout(filterTimer.current);
    filterTimer.current = window.setTimeout(() => {
      void st.setFilter(value);
    }, 320);
  };

  // 行数不多时全量渲染；超过 200 行才按滚动位置算可视窗口，
  // 上下各多渲染 8 行，滚动时不会露出空白。
  const ROW_H = 26;
  const HEAD_H = 28;
  const totalRows = rows.length;
  const vStart =
    totalRows > 200
      ? Math.max(
          0,
          Math.min(
            totalRows,
            Math.floor(Math.max(0, scrollTop - HEAD_H) / ROW_H) - 8,
          ),
        )
      : 0;
  const vEnd =
    totalRows > 200
      ? Math.min(
          totalRows,
          Math.ceil((Math.max(0, scrollTop - HEAD_H) + viewH) / ROW_H) + 8,
        )
      : totalRows;

  const pkIndexes = active?.columns.filter((c) => c.primaryKey).map((c) => c.name) ?? [];

  const startEdit = (rowIdx: number, colIdx: number) => {
    if (!active || sqlMode) return;
    if (pkIndexes.length === 0) {
      st.notify('这张表没有主键，无法安全生成 UPDATE，已跳过编辑');
      return;
    }
    const cell = rows[rowIdx]?.[colIdx];
    if (!cell || cell.t === 'binary') {
      st.notify('二进制列暂不支持编辑');
      return;
    }
    setEdit({ row: rowIdx, col: colIdx, value: cell.t === 'null' ? '' : asText(cell) });
  };

  const commitEdit = async (raw: string) => {
    if (!active || !edit) return;
    const column = columns[edit.col];
    if (!column) return;
    const keys: KeyValue[] = pkIndexes.map((name) => {
      const idx = columns.indexOf(name);
      const cell = rows[edit.row]?.[idx];
      return { column: name, value: cell ? asText(cell) : '' };
    });
    const value = raw === '' ? null : raw;
    setEdit(null);
    try {
      const preview = await api.updatePreview(active.connId, active.node, keys, column, value);
      setUpdate({ sql: preview.sql, keys, column, value, title: active.title });
    } catch (e) {
      st.notify(`生成 UPDATE 失败：${(e as Error).message}`);
    }
  };

  const applyUpdate = async () => {
    if (!active || !update) return;
    setApplying(true);
    try {
      const r = await api.applyUpdate(
        active.connId,
        active.node,
        update.keys,
        update.column,
        update.value,
      );
      st.notify(`已更新 ${r.applied ?? 0} 行`);
      setUpdate(null);
      await st.reloadActive();
    } catch (e) {
      st.notify(`更新失败：${(e as Error).message}`);
    } finally {
      setApplying(false);
    }
  };

  const openTabMenu = (e: React.MouseEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      title: st.tabs.find((t) => t.key === key)?.title,
      items: [
        { label: '关闭标签', onClick: () => st.closeTab(key) },
        { label: '关闭全部标签', danger: true, onClick: () => st.closeAllTabs() },
      ],
    });
  };

  const schemaKey = active ? `${active.connId}|${active.node.database ?? ''}|${active.node.schema ?? ''}` : '';
  useEffect(() => {
    if (!active || active.node.kind !== 'table') {
      setSchemaTables([]);
      return;
    }
    let alive = true;
    api
      .schemaMap(active.connId, { kind: 'schema', database: active.node.database, schema: active.node.schema })
      .then((t) => alive && setSchemaTables(t))
      .catch(() => alive && setSchemaTables([]));
    return () => {
      alive = false;
    };
    // schemaKey 覆盖连接 / 库 / schema 变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKey]);

  // 翻页 / 换排序 / 改筛选后行号与内容都会变，勾选状态必须清空，
  // 否则「删除选中」会对着新的一页执行。
  useEffect(() => {
    setSel(new Set());
  }, [active?.key, active?.page, active?.sortCol, active?.sortDesc, active?.filter]);

  const toggleSel = (ri: number, on: boolean) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (on) next.add(ri);
      else next.delete(ri);
      return next;
    });
  };

  const rowKeys = (ri: number): KeyValue[] =>
    pkIndexes.map((name) => {
      const idx = columns.indexOf(name);
      const cell = rows[ri]?.[idx];
      return { column: name, value: cell ? asText(cell) : '' };
    });

  const openRowMenu = (e: React.MouseEvent, ri: number) => {
    if (!active || sqlMode) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      title: `第 ${active.page * active.pageSize + ri + 1} 行`,
      items: [
        {
          label: '复制这一行（制表符分隔）',
          onClick: () => {
            const line = rows[ri]?.map(asText).join('\t') ?? '';
            void navigator.clipboard.writeText(line).then(
              () => st.notify('已复制到剪贴板'),
              () => st.notify('复制失败：浏览器未授予剪贴板权限'),
            );
          },
        },
        {
          label: '删除这一行',
          danger: true,
          disabled: readOnly,
          onClick: () => {
            if (pkIndexes.length === 0) {
              st.notify('这张表没有主键，无法安全定位要删除的行');
              return;
            }
            api
              .deletePreview(active.connId, active.node, rowKeys(ri))
              .then((r) => setDel({ sql: r.sql, keys: rowKeys(ri) }))
              .catch((err) => st.notify((err as Error).message));
          },
        },
      ],
    });
  };

  if (!active) {
    if (st.connections.length === 0) {
      return (
        <section className={s.main} onContextMenu={(e) => e.preventDefault()}>
          <div className={s.emptyArea}>
            <div className={s.card}>
              <EmptyDbIcon size={52} />
              <h1 className={s.title}>还没有数据库连接</h1>
              <p className={s.desc}>
                添加一个 MySQL、PostgreSQL 或 SQLite 连接，即可浏览库表结构、查看数据、执行 SQL 查询。
              </p>
              <button className={s.primary} onClick={() => st.openDialog()}>
                <PlusIcon color="#fff" size={13} />
                新建连接
              </button>
              <p className={s.support}>支持 MySQL 8 · PostgreSQL 14+ · SQLite 3</p>
            </div>
          </div>
        </section>
      );
    }
    return (
      <section className={s.main} onContextMenu={(e) => e.preventDefault()}>
        <div className={s.emptyArea}>
          <div className={s.card}>
            <TableIcon size={46} color="#d9907f" />
            <h1 className={s.title}>展开连接，选择一张表</h1>
            <p className={s.desc}>
              在左侧点击连接展开库表结构，选中表名即可在这里查看数据；右键可以打开数据、复制名称。
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={s.main} onContextMenu={(e) => e.preventDefault()}>
      <div
        className={s.tabs}
        ref={tabsRef}
        onWheel={(e) => {
          const box = e.currentTarget;
          if (box.scrollWidth <= box.clientWidth) return;
          // 标签溢出时把纵向滚轮转成横向滚动，鼠标也能翻到后面的标签
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) box.scrollLeft += e.deltaY;
        }}
      >
        {st.tabs.map((t) => (
          <div
            key={t.key}
            data-tab-key={t.key}
            className={t.key === st.activeKey ? `${s.tab} ${s.tabOn}` : s.tab}
            onClick={() => st.activateTab(t.key)}
            onContextMenu={(e) => openTabMenu(e, t.key)}
            title={t.title}
          >
            <span className={s.tabDot} style={{ background: t.color }} />
            <span className={s.tabTitle}>{t.title}</span>
            <button
              className={s.tabClose}
              onClick={(e) => {
                e.stopPropagation();
                st.closeTab(t.key);
              }}
              aria-label="关闭标签"
            >
              ✕
            </button>
          </div>
        ))}
        <div className={s.tabBlank} />
      </div>

      <div className={s.toolbar}>
        <button className={active.sqlOpen ? `${s.toolBtn} ${s.toolOn}` : s.toolBtn} onClick={() => st.toggleSql()}>
          SQL
        </button>
        <button className={s.toolBtn} onClick={() => void st.reloadActive()}>
          刷新
        </button>
        <button className={s.toolBtn} onClick={() => void st.exportCsv()} title="导出这张表的数据到 CSV">
          导出 CSV
        </button>
        {active.node.kind === 'table' ? (
          <button
            className={s.toolBtn}
            onClick={() => setInsertOpen(true)}
            title="向这张表插入一行数据"
            disabled={readOnly}
          >
            新增行
          </button>
        ) : null}
        {!sqlMode && active.node.kind === 'table' && sel.size > 0 ? (
          <button
            className={`${s.toolBtn} ${s.toolDanger}`}
            disabled={readOnly}
            title="删除勾选的行（按主键定位，先看 SQL 再确认）"
            onClick={() => {
              const keys = [...sel]
                .sort((a, b) => a - b)
                .map((ri) => rowKeys(ri));
              api
                .deleteManyPreview(active.connId, active.node, keys)
                .then((r) => setMultiDel({ sql: r.sql, rows: keys }))
                .catch((err) => st.notify((err as Error).message));
            }}
          >
            删除选中（{sel.size}）
          </button>
        ) : null}
        <span className={s.toolSep} />
        <input
          className={s.filterInput}
          value={filterInput}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="筛选（所有列包含）"
          spellCheck={false}
          aria-label="表格筛选"
        />
        {active.sortCol ? (
          <span className={s.sortHint}>
            {active.sortCol} {active.sortDesc ? '↓' : '↑'}
          </span>
        ) : null}
        {active.gridLoading || active.sqlRunning ? <span className={s.loadingHint}>加载中…</span> : null}
        {active.sqlResult?.notice ? (
          <span className={s.noticeHint}>{active.sqlResult.notice}</span>
        ) : null}
        <span className={s.spacer} />
        {active.sqlResult && active.sqlResult.isQuery ? (
          <span className={s.tbMeta}>
            查询 {active.sqlResult.rows.length} 行 · {active.sqlResult.elapsedMs} ms
          </span>
        ) : active.sqlResult && !active.sqlResult.isQuery ? (
          <span className={s.tbMeta}>影响 {active.sqlResult.affected ?? 0} 行</span>
        ) : active.sqlError ? (
          <span className={s.tbMetaFail}>执行失败</span>
        ) : active.result ? (
          <span className={s.tbMeta}>
            {active.result.rows.length} 行 · {active.result.elapsedMs} ms · {active.result.fetchedAt}
          </span>
        ) : null}
      </div>

      {active.sqlOpen ? (
        <div className={s.sqlPane}>
          <div className={s.sqlBar}>
            <span className={s.sqlTitle}>SQL 编辑器</span>
            <span className={s.sqlHint}>⌘↵ 执行</span>
            <span className={s.spacer} />
            <div className={s.historyWrap}>
              <button className={s.toolBtn} onClick={() => setShowHistory((v) => !v)}>
                历史
              </button>
              {showHistory ? (
                <div className={s.historyList} role="list">
                  {st.sqlHistory.length === 0 ? (
                    <div className={s.historyEmpty}>还没有执行过的 SQL</div>
                  ) : (
                    st.sqlHistory.map((item, i) => (
                      <button
                        key={i}
                        role="listitem"
                        className={s.historyItem}
                        title={item}
                        onClick={() => {
                          st.useHistory(item);
                          setShowHistory(false);
                        }}
                      >
                        {item.replace(/\s+/g, ' ').slice(0, 96)}
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
            {sqlMode ? (
              <button className={s.toolBtn} onClick={() => st.clearSqlResult()}>
                返回表数据
              </button>
            ) : null}
            <button className={s.toolBtn} onClick={() => st.setSqlText('')}>
              清空
            </button>
            {active.sqlRunning ? (
              <button className={s.sqlStop} onClick={() => void st.cancelSql()}>
                停止
              </button>
            ) : (
              <button className={s.sqlRun} onClick={() => void st.runSql()}>
                执行
              </button>
            )}
          </div>
          <div className={s.editorBox}>
            <SqlEditor
              value={active.sqlText}
              dialect={st.connections.find((c) => c.id === active.connId)?.kind}
              tables={[
                {
                  name: active.node.name ?? active.title,
                  columns: active.columns.map((c) => c.name),
                },
                ...schemaTables.filter(
                  (t) => t.name !== (active.node.name ?? active.title) && t.columns.length > 0,
                ),
              ]}
              onChange={(v) => st.setSqlText(v)}
              onRun={() => void st.runSql()}
            />
          </div>
          {active.sqlError ? <div className={s.sqlErr}>{active.sqlError}</div> : null}
        </div>
      ) : null}

      <div
        className={s.gridWrap}
        ref={gridRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {!sqlMode && active.gridError ? <div className={s.errBox}>{active.gridError}</div> : null}
        {columns.length > 0 ? (
          <table className={s.grid}>
            <colgroup>
              <col style={{ width: 54 }} />
              {widths.map((w, i) => (
                <col key={i} style={{ width: w }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {!sqlMode && active.node.kind === 'table' ? (
                  <th className={s.selHead}>
                    <input
                      type="checkbox"
                      aria-label="全选本页"
                      checked={rows.length > 0 && sel.size === rows.length}
                      onChange={(e) =>
                        setSel(e.target.checked ? new Set(rows.map((_, i) => i)) : new Set())
                      }
                    />
                  </th>
                ) : null}
                <th className={s.rowNoHead}>#</th>
                {columns.map((name) => {
                  const sorted = !sqlMode && active.sortCol === name;
                  return (
                    <th
                      key={name}
                      className={sqlMode ? s.th : `${s.th} ${s.thSortable}`}
                      onClick={sqlMode ? undefined : () => void st.setSort(name)}
                    >
                      <span className={s.thLabel}>{name}</span>
                      {sorted ? <span className={s.sortArrow}>{active.sortDesc ? '↓' : '↑'}</span> : null}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {vStart > 0 ? (
                <tr aria-hidden style={{ height: vStart * ROW_H }}>
                  <td
                    colSpan={columns.length + (sqlMode ? 1 : 2)}
                    style={{ padding: 0, border: 0 }}
                  />
                </tr>
              ) : null}
              {rows.slice(vStart, vEnd).map((row, vi) => {
                const ri = vStart + vi;
                return (
                <tr
                  key={ri}
                  onContextMenu={(e) => openRowMenu(e, ri)}
                  className={sel.has(ri) ? s.rowSel : undefined}
                >
                  {!sqlMode && active.node.kind === 'table' ? (
                    <td className={s.selCell}>
                      <input
                        type="checkbox"
                        aria-label={`选择第 ${ri + 1} 行`}
                        checked={sel.has(ri)}
                        onChange={(e) => toggleSel(ri, e.target.checked)}
                      />
                    </td>
                  ) : null}
                  <td className={s.rowNo}>
                    {sqlMode ? ri + 1 : active.page * active.pageSize + ri + 1}
                  </td>
                  {row.map((cell, ci) => {
                    const editing = !sqlMode && edit && edit.row === ri && edit.col === ci;
                    if (editing) {
                      return (
                        <td key={ci} className={`${s.td} ${s.tdEditing}`}>
                          <input
                            className={s.cellInput}
                            autoFocus
                            value={edit.value}
                            onChange={(e) => setEdit({ ...edit, value: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void commitEdit(edit.value);
                              if (e.key === 'Escape') setEdit(null);
                            }}
                            onBlur={() => setEdit(null)}
                          />
                        </td>
                      );
                    }
                    return (
                      <td
                        key={ci}
                        className={cellClass(cell)}
                        title={sqlMode ? asText(cell) : `${asText(cell)}（双击编辑）`}
                        onDoubleClick={() => startEdit(ri, ci)}
                      >
                        {asText(cell)}
                      </td>
                    );
                  })}
                </tr>
                );
              })}
              {vEnd < rows.length ? (
                <tr aria-hidden style={{ height: (rows.length - vEnd) * ROW_H }}>
                  <td
                    colSpan={columns.length + (sqlMode ? 1 : 2)}
                    style={{ padding: 0, border: 0 }}
                  />
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
        {!active.gridLoading && !sqlMode && columns.length === 0 && active.result ? (
          <div className={s.errBox}>这张表还没有数据</div>
        ) : null}
        {active.sqlError && columns.length === 0 ? (
          <div className={s.errBox}>SQL 执行失败，错误详情见编辑器下方</div>
        ) : null}
        {sqlMode && columns.length === 0 && !active.sqlError && active.sqlResult?.isQuery ? (
          <div className={s.errBox}>查询执行成功，但没有返回任何行</div>
        ) : null}
      </div>

      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      <RowInsertDialog
        open={insertOpen}
        title={active.title}
        connId={active.connId}
        node={active.node}
        columns={active.columns}
        production={production}
        onClose={() => setInsertOpen(false)}
        onDone={(_sql, applied) => {
          setInsertOpen(false);
          st.notify(`已插入 ${applied} 行`);
          void st.reloadActive();
        }}
      />
      <SqlConfirmDialog
        open={!!multiDel}
        title={`删除选中的 ${multiDel?.rows.length ?? 0} 行`}
        subtitle={`${active.title} · 按主键逐行定位，一次执行`}
        hint="删除不可撤销；条件用 OR 连接，只会命中勾选的主键"
        danger
        sql={multiDel?.sql ?? ''}
        applying={applying}
        production={production}
        onCancel={() => setMultiDel(null)}
        onConfirm={() => {
          if (!multiDel) return;
          setApplying(true);
          api
            .deleteManyApply(active.connId, active.node, multiDel.rows)
            .then((r) => {
              setMultiDel(null);
              setSel(new Set());
              if (r.undoId) st.setUndo({ id: r.undoId, label: `删除 ${r.applied ?? 0} 行` });
              st.notify(`已删除 ${r.applied ?? 0} 行`);
              void st.reloadActive();
            })
            .catch((err) => st.notify((err as Error).message))
            .finally(() => setApplying(false));
        }}
      />
      <SqlConfirmDialog
        open={!!del}
        title="删除这一行"
        subtitle={`${active.title} · 按主键定位，只删一行`}
        hint="删除不可撤销，请确认条件与主键值"
        danger
        sql={del?.sql ?? ''}
        applying={applying}
        production={production}
        onCancel={() => setDel(null)}
        onConfirm={() => {
          if (!del) return;
          setApplying(true);
          api
            .deleteApply(active.connId, active.node, del.keys)
            .then((r) => {
              setDel(null);
              if (r.undoId) st.setUndo({ id: r.undoId, label: '删除这一行' });
              st.notify(`已删除 ${r.applied ?? 0} 行`);
              void st.reloadActive();
            })
            .catch((err) => st.notify((err as Error).message))
            .finally(() => setApplying(false));
        }}
      />
      <UpdateDialog
        open={!!update}
        production={production}
        title={update?.title ?? ''}
        column={update?.column ?? ''}
        sql={update?.sql ?? ''}
        applying={applying}
        onCancel={() => setUpdate(null)}
        onConfirm={() => void applyUpdate()}
      />
    </section>
  );
}
