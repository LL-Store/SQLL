/**
 * 左侧结构树：连接 → 库 → schema → 表 / 视图 / 函数等分组。
 *
 * 节点展开状态与子节点都缓存在 store 里；点击表节点直接打开数据标签页，
 * 右键菜单按节点类型生成（服务器 / 表 / 其他对象各不一样，只读连接不出现写操作）。
 */

import { useState } from 'react';
import { ChevronIcon, DatabaseIcon, EmptyDbIcon, PlusIcon, ProcIcon, SearchIcon, TableIcon, TriggerIcon, ViewIcon } from './Icons';
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu';
import { useAppStore } from '@/store';
import { DB_META, makeConnNode, type TreeNode } from '@/types';
import s from './Sidebar.module.css';

function NodeIcon({ kind }: { kind: string }) {
  switch (kind) {
    case 'database':
      return <DatabaseIcon size={13} />;
    case 'table':
      return <TableIcon size={13} />;
    case 'view':
      return <ViewIcon size={13} />;
    case 'function':
    case 'procedure':
      return <ProcIcon size={13} />;
    case 'trigger':
      return <TriggerIcon size={13} />;
    default:
      return <DatabaseIcon size={13} color="#9aa0a8" />;
  }
}

export function Sidebar() {
  const st = useAppStore();
  const [keyword, setKeyword] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);

  const copyName = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      st.notify(`已复制：${text}`);
    } catch {
      st.notify('复制失败，请手动选择文本');
    }
  };

  const openNodeMenu = (e: React.MouseEvent, node: TreeNode, connId: string, color: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu(null);
    const conn = st.connections.find((c) => c.id === connId);
    const items: MenuItem[] = [];

    if (node.kind === 'server') {
      items.push({ label: '新建连接', onClick: () => st.openDialog() });
      if (conn) items.push({ label: '编辑连接', onClick: () => st.openDialog(conn) });
      items.push({
        label: '重新加载',
        hint: '库列表',
        onClick: () => void st.reloadNode(connId, node),
      });
      if (conn) {
        items.push({
          label: '删除连接',
          danger: true,
          onClick: () => {
            if (window.confirm(`确定删除连接「${conn.name}」吗？密码会同时从钥匙串移除。`)) {
              void st.removeConnection(conn.id);
            }
          },
        });
      }
    } else if (node.kind === 'table' || node.kind === 'view') {
      items.push({
        label: '打开数据',
        onClick: () => {
          void st.openTable({
            key: node.id,
            connId,
            connName: conn?.name ?? '',
            color,
            node: node.node,
            title: node.label,
          });
        },
      });
      items.push({ label: '复制名称', onClick: () => void copyName(node.label) });
      if (node.kind === 'view') {
        items.push({ label: '查看定义', onClick: () => void st.openObject(connId, node) });
      }
      items.push({ label: '重新加载', onClick: () => void st.reloadNode(connId, node) });
    } else {
      if (node.kind === 'function' || node.kind === 'procedure' || node.kind === 'trigger') {
        items.push({ label: '查看定义', onClick: () => void st.openObject(connId, node) });
      }
      items.push({ label: '重新加载', onClick: () => void st.reloadNode(connId, node) });
      if (node.kind === 'group') {
        items.push({ label: '复制名称', onClick: () => void copyName(node.label) });
      }
      if (node.kind === 'database' || node.kind === 'schema') {
        items.push({ label: '复制名称', onClick: () => void copyName(node.label) });
      }
    }
    setMenu({ x: e.clientX, y: e.clientY, title: node.label, items });
  };

  const renderNode = (node: TreeNode, connId: string, depth: number, color: string): JSX.Element => {
    const open = !!st.expanded[node.id];
    const state = st.nodes[node.id];
    const selected = st.selectedId === node.id;

    const onClick = () => {
      if (node.expandable) {
        void st.toggleNode(connId, node);
        return;
      }
      if (node.kind === 'table' || node.kind === 'view') {
        const conn = st.connections.find((c) => c.id === connId);
        void st.openTable({
          key: node.id,
          connId,
          connName: conn?.name ?? '',
          color,
          node: node.node,
          title: node.label,
        });
      } else if (
        node.kind === 'function' ||
        node.kind === 'procedure' ||
        node.kind === 'trigger' ||
        node.kind === 'view'
      ) {
        void st.openObject(connId, node);
      } else {
        st.notify(`${node.label}：这一类分组节点没有可查看的详情`);
      }
    };

    return (
      <div key={node.id} className={s.group}>
        <div
          className={selected ? `${s.node} ${s.nodeOn}` : s.node}
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={onClick}
          onContextMenu={(e) => openNodeMenu(e, node, connId, color)}
          title={node.label}
        >
          <span className={s.chev}>{node.expandable ? <ChevronIcon size={9} open={open} /> : null}</span>
          <span className={s.ico}>
            {node.kind === 'server' ? <span className={s.dot} style={{ background: color }} /> : <NodeIcon kind={node.kind} />}
          </span>
          <span className={s.label}>{node.label}</span>
          {typeof node.count === 'number' ? <span className={s.count}>{node.count}</span> : null}
        </div>
        {open && state?.loading ? (
          <div className={s.tip} style={{ paddingLeft: 26 + depth * 12 }}>
            加载中…
          </div>
        ) : null}
        {open && state?.error ? (
          <div className={`${s.tip} ${s.tipErr}`} style={{ paddingLeft: 26 + depth * 12 }}>
            {state.error}
          </div>
        ) : null}
        {open && state?.children?.map((child) => renderNode(child, connId, depth + 1, color))}
      </div>
    );
  };

  const empty = st.connections.length === 0;
  const kw = keyword.trim().toLowerCase();
  const visible = st.connections.filter((c) => (kw ? c.name.toLowerCase().includes(kw) : true));

  return (
    <aside className={s.side} onContextMenu={(e) => e.preventDefault()}>
      <div className={s.top}>
        <div className={s.searchBox}>
          <SearchIcon />
          <input
            className={s.searchInput}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索连接"
            spellCheck={false}
          />
        </div>
        <button
          className={s.addBtn}
          onClick={() => st.openDialog()}
          title="新建数据库服务器连接"
          aria-label="新建数据库服务器连接"
        >
          <PlusIcon />
        </button>
      </div>

      <div className={s.tree}>
        {empty ? (
          <div className={s.empty}>
            <EmptyDbIcon size={36} />
            <p className={s.emptyTitle}>还没有数据库连接</p>
            <p className={s.emptyDesc}>点击右上角 + 添加连接</p>
            <button className={s.emptyBtn} onClick={() => st.openDialog()}>
              新建连接
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className={s.tip}>没有匹配的连接</div>
        ) : (
          visible.map((c) => renderNode(makeConnNode(c), c.id, 0, c.color || DB_META[c.kind].color))
        )}
      </div>

      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </aside>
  );
}
