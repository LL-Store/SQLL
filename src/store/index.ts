/**
 * 全局状态（zustand）。
 *
 * 三类状态放在一起：
 * - 连接 / 树：`connections`、`nodes`（按节点 id 缓存子节点，避免重复展开时再查）、`expanded`；
 * - 标签页：每个打开的表一个 `TableTabState`，分页、排序、筛选、SQL 编辑器状态都挂在标签上，
 *   切标签不会互相影响；
 * - 偏好：`settings` 与 SQL 历史持久化在 localStorage，其余（撤销栈、节点缓存）只在内存里。
 */

import { create } from 'zustand';
import { api, errMessage, inTauri } from '@/services/ipc';
import type { ColumnMeta, ConnectionConfig, NodeRef, ResultSet, SqlResult, TreeNode } from '@/types';

interface NodeState {
  children: TreeNode[];
  loading: boolean;
  error: string | null;
}

/**
 * 推导某结构树节点的父级 NodeRef，用于删表 / 批量操作后逐级向上刷新计数。
 * 层级：MySQL/SQLite  server→database→group→table；PG  server→database→schema→group→table。
 * 已到顶层（server/database）时返回 null。
 */
function parentOf(node: NodeRef, kind: string): NodeRef | null {
  switch (node.kind) {
    case 'table':
    case 'view':
    case 'function':
    case 'procedure':
    case 'trigger':
      return {
        kind: 'group',
        database: node.database,
        schema: node.schema,
        name: null,
        group: node.group ?? node.kind,
      };
    case 'group':
      // PG 的分组挂在 schema 下；其余挂在 database 下。
      if (kind === 'postgres') {
        return {
          kind: 'schema',
          database: node.database,
          schema: node.schema,
          name: null,
          group: null,
        };
      }
      return {
        kind: 'database',
        database: node.database,
        schema: null,
        name: null,
        group: null,
      };
    case 'schema':
      return {
        kind: 'database',
        database: node.database,
        schema: null,
        name: null,
        group: null,
      };
    default:
      return null;
  }
}

export interface TableTab {
  key: string;
  connId: string;
  connName: string;
  color: string;
  node: NodeRef;
  title: string;
}

export interface TableTabState extends TableTab {
  columns: ColumnMeta[];
  columnsLoading: boolean;
  result: ResultSet | null;
  gridLoading: boolean;
  gridError: string | null;
  page: number;
  pageSize: number;
  sortCol: string | null;
  sortDesc: boolean;
  filter: string;
  sqlOpen: boolean;
  sqlText: string;
  sqlResult: SqlResult | null;
  sqlError: string | null;
  sqlRunning: boolean;
}

interface AppState {
  connections: ConnectionConfig[];
  activeConnectionId: string | null;
  dialogOpen: boolean;
  editing: ConnectionConfig | null;
  toast: string | null;
  /** 刚删除的一批行，可撤销（内存里只保留最近一次） */
  undo: { id: string; label: string } | null;
  sqlHistory: string[];
  settings: Settings;
  settingsOpen: boolean;

  /** 视图 / 函数 / 存储过程 / 触发器的定义弹窗 */
  objectInfo: { title: string; kind: string; sql: string; loading: boolean; error: string | null } | null;
  /** 右侧 Inspector 当前分段；右键「级联关系」会切到外键段 */
  inspectorSection: 'columns' | 'indexes' | 'fks' | 'ddl';
  setInspectorSection: (section: 'columns' | 'indexes' | 'fks' | 'ddl') => void;

  /** 「新增表」弹窗上下文：定位到目标库 / schema */
  tableCreate: { connId: string; node: NodeRef; scopeLabel: string } | null;
  /** 危险结构操作（删表 / 清表 / 批量删表 / 批量清表）确认弹窗上下文 */
  structConfirm: {
    connId: string;
    node: NodeRef;
    kind: 'drop-table' | 'truncate-table' | 'drop-all' | 'truncate-all';
    title: string;
    subtitle: string;
    hint: string;
    sql: string;
    tables: string[];
    applying: boolean;
  } | null;

  nodes: Record<string, NodeState>;
  expanded: Record<string, boolean>;
  selectedId: string | null;

  tabs: TableTabState[];
  activeKey: string | null;

  boot: () => Promise<void>;
  openDialog: (conn?: ConnectionConfig) => void;
  closeDialog: () => void;
  saveConnection: (conn: ConnectionConfig, password?: string, sshPassword?: string) => Promise<void>;
  removeConnection: (id: string) => Promise<void>;
  notify: (message: string) => void;
  setUndo: (undo: { id: string; label: string } | null) => void;
  dismissUndo: () => void;
  undoDelete: () => Promise<void>;
  dismissToast: () => void;
  toggleNode: (connId: string, node: TreeNode) => Promise<void>;
  reloadNode: (connId: string, node: TreeNode) => Promise<void>;
  openTable: (tab: TableTab) => Promise<void>;
  activateTab: (key: string) => void;
  reloadActive: () => Promise<void>;
  loadPage: (page: number) => Promise<void>;
  setPageSize: (size: number) => Promise<void>;
  setSort: (col: string) => Promise<void>;
  setFilter: (value: string) => Promise<void>;
  toggleSql: () => void;
  setSqlText: (value: string) => void;
  runSql: () => Promise<void>;
  clearSqlResult: () => void;
  exportCsv: () => Promise<void>;
  useHistory: (sql: string) => void;
  cancelSql: () => Promise<void>;
  openSettings: () => void;
  openObject: (connId: string, node: TreeNode) => Promise<void>;
  closeObject: () => void;
  openTableCreate: (connId: string, node: NodeRef, scopeLabel: string) => void;
  closeTableCreate: () => void;
  reloadScope: (connId: string, node: NodeRef) => Promise<void>;
  requestStructConfirm: (
    connId: string,
    node: NodeRef,
    kind: 'drop-table' | 'truncate-table' | 'drop-all' | 'truncate-all',
  ) => Promise<void>;
  closeStructConfirm: () => void;
  runStructConfirm: () => Promise<void>;
  closeSettings: () => void;
  saveSettings: (patch: Partial<Settings>) => void;
  closeTab: (key: string) => void;
  closeAllTabs: () => void;
}

const DEFAULT_PAGE_SIZE = 100;
const SETTINGS_KEY = 'sqll:settings';

export interface Settings {
  pageSize: number;
  editorFontSize: number;
  theme: 'light' | 'dark' | 'system';
}

const DEFAULT_SETTINGS: Settings = {
  pageSize: DEFAULT_PAGE_SIZE,
  editorFontSize: 12,
  theme: 'light',
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      pageSize: [50, 100, 200, 500].includes(Number(parsed.pageSize))
        ? Number(parsed.pageSize)
        : DEFAULT_SETTINGS.pageSize,
      editorFontSize: [11, 12, 13, 14].includes(Number(parsed.editorFontSize))
        ? Number(parsed.editorFontSize)
        : DEFAULT_SETTINGS.editorFontSize,
      theme:
        parsed.theme === 'dark' || parsed.theme === 'system' ? parsed.theme : 'light',
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
const HISTORY_KEY = 'sqll:sql-history';

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function pushHistory(sql: string): string[] {
  const item = sql.trim();
  if (!item) return loadHistory();
  const prev = loadHistory().filter((x) => x !== item);
  const next = [item, ...prev].slice(0, 30);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* localStorage 不可用时忽略 */
  }
  return next;
}

function defaultSql(node: NodeRef): string {
  const name = node.name ?? '';
  const qualified = node.schema ? `${node.schema}.${name}` : name;
  return `SELECT *\nFROM ${qualified}\nLIMIT 100;`;
}

export const useAppStore = create<AppState>((set, get) => {
  const patchTab = (key: string, patch: Partial<TableTabState>) =>
    set((st) => ({ tabs: st.tabs.map((t) => (t.key === key ? { ...t, ...patch } : t)) }));

  const activeTab = () => {
    const st = get();
    return st.tabs.find((t) => t.key === st.activeKey) ?? null;
  };

  const loadNode = async (connId: string, node: TreeNode) => {
    set((st) => ({
      nodes: { ...st.nodes, [node.id]: { children: [], loading: true, error: null } },
      expanded: { ...st.expanded, [node.id]: true },
    }));
    try {
      const children = await api.children(connId, node.node);
      set((st) => ({ nodes: { ...st.nodes, [node.id]: { children, loading: false, error: null } } }));
    } catch (e) {
      set((st) => ({
        nodes: {
          ...st.nodes,
          [node.id]: { children: [], loading: false, error: errMessage(e) },
        },
      }));
    }
  };

  const fetchRows = async (tab: TableTabState, page: number) => {
    patchTab(tab.key, { page, gridLoading: true, gridError: null });
    try {
      const result = await api.rows(
        tab.connId,
        tab.node,
        tab.pageSize,
        page * tab.pageSize,
        tab.sortCol,
        tab.sortDesc,
        tab.filter,
      );
      patchTab(tab.key, { result, gridLoading: false });
    } catch (e) {
      patchTab(tab.key, { gridLoading: false, gridError: errMessage(e) });
    }
  };

  return {
    connections: [],
    activeConnectionId: null,
    dialogOpen: false,
    editing: null,
    toast: null,
    undo: null,
    sqlHistory: loadHistory(),
    settings: loadSettings(),
    settingsOpen: false,
    objectInfo: null,
    inspectorSection: 'columns',
    tableCreate: null,
    structConfirm: null,
    nodes: {},
    expanded: {},
    selectedId: null,
    tabs: [],
    activeKey: null,

    // 浏览器预览没有 Tauri 运行时，boot 直接跳过，界面仍可空跑
    boot: async () => {
      if (!inTauri) return;
      try {
        const list = await api.listConnections();
        set({ connections: list ?? [] });
      } catch (e) {
        set({ toast: errMessage(e) });
      }
    },

    openDialog: (conn) => set({ dialogOpen: true, editing: conn ?? null }),
    closeDialog: () => set({ dialogOpen: false, editing: null }),

    saveConnection: async (conn, password, sshPassword) => {
      try {
        const saved = await api.saveConnection(conn, password, sshPassword);
        const list = get().connections;
        const exists = list.some((c) => c.id === saved.id);
        set({
          connections: exists ? list.map((c) => (c.id === saved.id ? saved : c)) : [...list, saved],
          dialogOpen: false,
          editing: null,
          toast: exists ? '连接已更新' : `已添加连接：${saved.name}`,
        });
      } catch (e) {
        set({ toast: `保存失败：${errMessage(e)}` });
      }
    },

    removeConnection: async (id) => {
      try {
        await api.deleteConnection(id);
        set((st) => ({
          connections: st.connections.filter((c) => c.id !== id),
          tabs: st.tabs.filter((t) => t.connId !== id),
          toast: '连接已删除',
        }));
      } catch (e) {
        set({ toast: `删除失败：${errMessage(e)}` });
      }
    },

    notify: (message) => set({ toast: message }),
    setUndo: (undo) => set({ undo }),
    dismissUndo: () => set({ undo: null }),
    undoDelete: async () => {
      const undo = get().undo;
      if (!undo) return;
      try {
        const n = await api.undoDelete(undo.id);
        set({ undo: null, toast: `已恢复 ${n} 行` });
        await get().reloadActive();
      } catch (e) {
        set({ undo: null, toast: `撤销失败：${errMessage(e)}` });
      }
    },
    dismissToast: () => set({ toast: null }),

    toggleNode: async (connId, node) => {
      if (get().expanded[node.id]) {
        set((st) => ({ expanded: { ...st.expanded, [node.id]: false } }));
        return;
      }
      set({ selectedId: node.id, activeConnectionId: connId });
      if (get().nodes[node.id]?.children?.length) {
        set((st) => ({ expanded: { ...st.expanded, [node.id]: true } }));
        return;
      }
      await loadNode(connId, node);
    },

    reloadNode: async (connId, node) => {
      set((st) => {
        const nodes = { ...st.nodes };
        delete nodes[node.id];
        return { nodes };
      });
      await loadNode(connId, node);
    },

    openTable: async (base) => {
      const existing = get().tabs.find((t) => t.key === base.key);
      if (existing) {
        set({ activeKey: existing.key, selectedId: base.key, activeConnectionId: base.connId });
        // 已打开过的标签重新聚焦时刷新一次，避免看到旧数据
        await fetchRows(existing, existing.page);
        return;
      }
      const tab: TableTabState = {
        ...base,
        columns: [],
        columnsLoading: true,
        result: null,
        gridLoading: true,
        gridError: null,
        page: 0,
        pageSize: get().settings.pageSize,
        sortCol: null,
        sortDesc: false,
        filter: '',
        sqlOpen: false,
        sqlText: defaultSql(base.node),
        sqlResult: null,
        sqlError: null,
        sqlRunning: false,
      };
      set((st) => ({
        tabs: [...st.tabs, tab],
        activeKey: tab.key,
        selectedId: tab.key,
        activeConnectionId: base.connId,
      }));
      const cols = await api.columns(base.connId, base.node).catch(() => [] as ColumnMeta[]);
      patchTab(tab.key, { columns: cols, columnsLoading: false });
      await fetchRows(tab, 0);
    },

    activateTab: (key) => set({ activeKey: key, selectedId: key }),

    reloadActive: async () => {
      const tab = activeTab();
      if (tab) await fetchRows(tab, tab.page);
    },

    loadPage: async (page) => {
      const tab = activeTab();
      if (tab) await fetchRows(tab, page);
    },

    setPageSize: async (size) => {
      const tab = activeTab();
      if (!tab) return;
      patchTab(tab.key, { pageSize: size });
      await fetchRows({ ...tab, pageSize: size }, 0);
    },

    closeTab: (key) => {
      const st = get();
      const idx = st.tabs.findIndex((t) => t.key === key);
      const rest = st.tabs.filter((t) => t.key !== key);
      // 关掉当前标签后聚焦原位置的下一个，没有就退到前一个
      const nextActive = st.activeKey === key ? rest[Math.min(idx, rest.length - 1)]?.key ?? null : st.activeKey;
      set({ tabs: rest, activeKey: nextActive, selectedId: nextActive });
    },

    setSort: async (col) => {
      const tab = activeTab();
      if (!tab) return;
      const desc = tab.sortCol === col ? !tab.sortDesc : false;
      patchTab(tab.key, { sortCol: col, sortDesc: desc });
      await fetchRows({ ...tab, sortCol: col, sortDesc: desc }, 0);
    },

    setFilter: async (value) => {
      const tab = activeTab();
      if (!tab) return;
      patchTab(tab.key, { filter: value });
      await fetchRows({ ...tab, filter: value }, 0);
    },

    toggleSql: () => {
      const tab = activeTab();
      if (!tab) return;
      patchTab(tab.key, { sqlOpen: !tab.sqlOpen });
    },

    setSqlText: (value) => {
      const tab = activeTab();
      if (!tab) return;
      patchTab(tab.key, { sqlText: value });
    },

    runSql: async () => {
      const tab = activeTab();
      if (!tab) return;
      if (!tab.sqlText.trim()) {
        patchTab(tab.key, { sqlError: '请输入 SQL' });
        return;
      }
      // 执行期间先清掉上一次的结果：失败时网格应留空并显示错误，
      // 而不是继续显示上一次查询结果或表数据（否则看起来像「点了执行没反应」）
      patchTab(tab.key, { sqlRunning: true, sqlError: null, sqlResult: null });
      set({ sqlHistory: pushHistory(tab.sqlText) });
      try {
        const result = await api.execute(tab.connId, tab.node.database ?? null, tab.sqlText);
        patchTab(tab.key, { sqlResult: result, sqlRunning: false });
        // 写语句执行后刷新表数据，查询语句不额外触发一次取数
        if (!result.isQuery && tab.node.name) {
          await fetchRows({ ...tab, page: 0 }, 0);
        }
      } catch (e) {
        const msg = errMessage(e);
        patchTab(tab.key, {
          sqlRunning: false,
          sqlError: msg === '查询已取消' ? null : msg,
        });
        if (msg === '查询已取消') set({ toast: '查询已取消' });
      }
    },

    cancelSql: async () => {
      const tab = activeTab();
      if (!tab) return;
      try {
        await api.cancelSql(tab.connId, tab.node.database ?? null);
      } catch (e) {
        set({ toast: errMessage(e) });
      }
    },

    clearSqlResult: () => {
      const tab = activeTab();
      if (!tab) return;
      patchTab(tab.key, { sqlResult: null, sqlError: null });
    },

    exportCsv: async () => {
      const tab = activeTab();
      if (!tab) return;
      try {
        const r = await api.exportCsv(tab.connId, tab.node, 100000);
        set({ toast: `已导出 ${r.rows} 行到 ${r.path}` });
      } catch (e) {
        set({ toast: `导出失败：${errMessage(e)}` });
      }
    },

    useHistory: (sql) => {
      const tab = activeTab();
      if (!tab) return;
      patchTab(tab.key, { sqlText: sql });
    },

    openSettings: () => set({ settingsOpen: true }),
    openObject: async (connId, node) => {
      set({
        objectInfo: { title: node.label, kind: node.kind, sql: '', loading: true, error: null },
      });
      try {
        const r = await api.objectDdl(connId, node.node);
        set((s) =>
          s.objectInfo
            ? { objectInfo: { ...s.objectInfo, sql: r.sql, loading: false } }
            : {},
        );
      } catch (e) {
        set((s) =>
          s.objectInfo
            ? { objectInfo: { ...s.objectInfo, loading: false, error: errMessage(e) } }
            : {},
        );
      }
    },

    closeObject: () => set({ objectInfo: null }),
    setInspectorSection: (section) => set({ inspectorSection: section }),

    openTableCreate: (connId, node, scopeLabel) => set({ tableCreate: { connId, node, scopeLabel } }),
    closeTableCreate: () => set({ tableCreate: null }),

    requestStructConfirm: async (connId, node, kind) => {
      const conn = get().connections.find((c) => c.id === connId);
      const scopeLabel = conn?.name ?? node.name ?? '';
      let title = '';
      let subtitle = scopeLabel;
      let hint = '';
      let sql = '';
      let tables: string[] = [];
      try {
        if (kind === 'drop-table' || kind === 'truncate-table') {
          // 单表：预览语句由后端按方言生成（不执行）
          const r =
            kind === 'drop-table'
              ? await api.dropTablePreview(connId, node)
              : await api.truncateTablePreview(connId, node);
          sql = r.sql;
          tables = node.name ? [node.name] : [];
          title =
            kind === 'drop-table'
              ? `删除表「${node.name ?? ''}」`
              : `清空表「${node.name ?? ''}」数据`;
          hint =
            kind === 'drop-table'
              ? '删除后表结构与数据都会丢失，且不可撤销'
              : '只清空数据，表结构保留；不可撤销';
        } else {
          // 批量：后端先列出表名并按方言拼好多条语句（不执行），弹窗整体展示
          const mode = kind === 'drop-all' ? 'drop' : 'truncate';
          const r = await api.scopePreview(connId, node, mode);
          tables = await api.scopeTables(connId, node);
          if (tables.length === 0) {
            set({ toast: '当前作用域下没有可操作的表' });
            return;
          }
          sql = r.sql;
          if (kind === 'drop-all') {
            title = `删除全部 ${tables.length} 张表`;
            hint = '删除后这些表的结构与数据都会丢失，且不可撤销';
          } else {
            title = `清空全部 ${tables.length} 张表的数据`;
            hint = '只清空数据，表结构保留；不可撤销';
          }
        }
      } catch (e) {
        set({ toast: errMessage(e) });
        return;
      }
      set({ structConfirm: { connId, node, kind, title, subtitle, hint, sql, tables, applying: false } });
    },

    reloadScope: async (connId, node) => {
      const connKind = get().connections.find((c) => c.id === connId)?.kind ?? 'mysql';
      // 拼出与后端 node_id 一致的缓存键（4 段：kind|db|schema|name）。
      // 分组节点第 4 段是 group 类型；其余层级第 4 段是 name。
      const reloadOne = async (ref: NodeRef) => {
        // 与后端 node_id/group_node 对齐第 4 段：
        //   group  → group 类型；database → database 名；schema → schema 名；其余 → name。
        let fourth = ref.name ?? '';
        if (ref.kind === 'group') fourth = ref.group ?? '';
        else if (ref.kind === 'database') fourth = ref.database ?? '';
        else if (ref.kind === 'schema') fourth = ref.schema ?? '';
        const id = [ref.kind, ref.database ?? '', ref.schema ?? '', fourth].join('|');
        const tree: TreeNode = { id, kind: ref.kind, label: '', expandable: true, node: ref };
        await get().reloadNode(connId, tree);
      };
      await reloadOne(node);
      // 逐级向上重载祖先：分组计数挂在父级 children 里的节点对象上，
      // 只重载当前层刷不到父级的 count，必须把祖先一并刷新。
      let cursor = parentOf(node, connKind);
      while (cursor) {
        await reloadOne(cursor);
        cursor = parentOf(cursor, connKind);
      }
    },

    closeStructConfirm: () => set({ structConfirm: null }),

    runStructConfirm: async () => {
      const sc = get().structConfirm;
      if (!sc || sc.applying) return;
      set((st) => (st.structConfirm ? { structConfirm: { ...st.structConfirm, applying: true } } : {}));
      try {
        if (sc.kind === 'drop-table') await api.dropTable(sc.connId, sc.node);
        else if (sc.kind === 'truncate-table') await api.truncateTable(sc.connId, sc.node);
        else if (sc.kind === 'drop-all') await api.scopeDropAll(sc.connId, sc.node);
        else await api.scopeTruncateAll(sc.connId, sc.node);

        // 删掉被影响的已打开标签：删表 / 删全部表后这些标签的数据已不存在
        const removedTabs = get().tabs.filter((t) => {
          if (t.connId !== sc.connId) return false;
          if (sc.kind === 'drop-table') return t.node.name === sc.node.name;
          if (sc.kind === 'drop-all' || sc.kind === 'truncate-all') {
            // 批量清表保留标签；批量删表关闭本连接下所有表标签
            return sc.kind === 'drop-all';
          }
          return false;
        });
        const removeKeys = new Set(removedTabs.map((t) => t.key));
        const rest = get().tabs.filter((t) => !removeKeys.has(t.key));
        const nextActive = rest.find((t) => t.key === get().activeKey)?.key ?? rest[0]?.key ?? null;
        set({
          tabs: rest,
          activeKey: nextActive,
          selectedId: nextActive,
          structConfirm: null,
        });

        // 刷新结构树：删表后从其父分组开始逐级向上重载；作用域级操作从当前节点向上重载。
        if (sc.kind === 'drop-table') {
          const parent: NodeRef = {
            kind: 'group',
            database: sc.node.database,
            schema: sc.node.schema,
            name: null,
            group: sc.node.group ?? 'table',
          };
          await get().reloadScope(sc.connId, parent);
        } else {
          await get().reloadScope(sc.connId, sc.node);
        }
        const action =
          sc.kind === 'drop-table'
            ? `已删除表「${sc.node.name ?? ''}」`
            : sc.kind === 'truncate-table'
              ? `已清空表「${sc.node.name ?? ''}」数据`
              : sc.kind === 'drop-all'
                ? `已删除 ${sc.tables.length} 张表`
                : `已清空 ${sc.tables.length} 张表的数据`;
        set({ toast: action });
      } catch (e) {
        // 失败时保留弹窗，解除执行态，便于用户重试或取消
        set((st) =>
          st.structConfirm ? { structConfirm: { ...st.structConfirm, applying: false } } : {},
        );
        set({ toast: `操作失败：${errMessage(e)}` });
      }
    },

    closeSettings: () => set({ settingsOpen: false }),

    saveSettings: (patch) => {
      const next = { ...get().settings, ...patch };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        /* 忽略 */
      }
      set({ settings: next });
    },

    closeAllTabs: () => set({ tabs: [], activeKey: null, selectedId: null }),
  };
});
