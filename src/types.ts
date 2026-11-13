/**
 * 前后端共享的类型与展示元数据。
 *
 * 与 `src-tauri/src/model.rs` 一一对应（Rust 侧序列化成 camelCase）：
 * 改字段要两边一起改，否则前端拿到的是 undefined。
 * `Cell` 用判别式联合（`t`）表示，渲染时按 `cell.t` 分支，避免类型猜测。
 */

export type DbKind = 'mysql' | 'postgres' | 'sqlite';

export type SslMode = 'disabled' | 'preferred' | 'required' | 'verify-ca' | 'verify-full';

export interface ConnectionConfig {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  database?: string | null;
  user?: string | null;
  /** 密码只存系统钥匙串，这里仅表示是否存在 */
  hasPassword?: boolean;
  sslMode: SslMode;
  caPath?: string | null;
  color?: string | null;
  readOnly?: boolean | null;
  production?: boolean | null;
  filePath?: string | null;
  /** 是否启用 SSH 隧道 */
  sshEnabled?: boolean | null;
  /** 跳板机主机 */
  sshHost?: string | null;
  /** 跳板机端口（默认 22） */
  sshPort?: number;
  /** SSH 登录用户名 */
  sshUser?: string | null;
  /** 认证方式：password | publickey */
  sshAuth?: 'password' | 'publickey' | null;
  /** 私钥文件路径（publickey 方式，留空读 ~/.ssh/id_rsa） */
  sshKeyPath?: string | null;
}

export const DB_META: Record<DbKind, { label: string; defaultPort: number; color: string }> = {
  mysql: { label: 'MySQL', defaultPort: 3306, color: '#e5533d' },
  postgres: { label: 'PostgreSQL', defaultPort: 5432, color: '#3a82d8' },
  sqlite: { label: 'SQLite', defaultPort: 0, color: '#5ba85b' },
};

export const APP_VERSION = __APP_VERSION__;

/** 项目仓库地址，构建时从 package.json 的 repository 字段注入 */
export const APP_REPOSITORY = __APP_REPOSITORY__;

/** 树节点引用，原样回传给 Rust 定位下一层 */
export interface NodeRef {
  kind: string;
  database?: string | null;
  schema?: string | null;
  name?: string | null;
  group?: string | null;
}

export interface TreeNode {
  id: string;
  kind: 'database' | 'schema' | 'group' | 'table' | 'view' | 'function' | 'procedure' | 'trigger' | string;
  label: string;
  count?: number | null;
  expandable: boolean;
  node: NodeRef;
}

export interface ColumnMeta {
  name: string;
  typeName: string;
  nullable: boolean;
  defaultValue?: string | null;
  primaryKey: boolean;
  comment?: string | null;
}

export type Cell =
  | { t: 'null' }
  | { t: 'text'; v: string }
  | { t: 'int'; v: number }
  | { t: 'float'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'binary'; v: number };

export interface KeyValue {
  column: string;
  value: string;
}

export interface UpdateResult {
  sql: string;
  applied?: number | null;
}

export interface ExportResult {
  path: string;
  rows: number;
}

export interface SqlResult {
  columns: string[];
  rows: Cell[][];
  elapsedMs: number;
  fetchedAt: string;
  affected?: number | null;
  isQuery: boolean;
  /** 本次执行了几条语句（多语句用 ; 分隔） */
  executed: number;
  /** 多语句汇总说明，如「共执行 2 条语句，累计影响 3 行」 */
  notice: string | null;
}

export interface ResultSet {
  columns: string[];
  rows: Cell[][];
  elapsedMs: number;
  fetchedAt: string;
  /** 当前筛选条件下的总行数 */
  total?: number | null;
}

export interface IndexMeta {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  method?: string | null;
}

export interface ForeignKeyMeta {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete?: string | null;
  onUpdate?: string | null;
}

export interface DdlResult {
  sql: string;
  /** true = 由字段元数据拼装，不是数据库原始 DDL */
  generated: boolean;
}

export interface TestResult {
  version: string;
  latencyMs: number;
}

export function connKey(conn: ConnectionConfig): string {
  return `conn|${conn.id}`;
}

export function makeConnNode(conn: ConnectionConfig): TreeNode {
  return {
    id: connKey(conn),
    kind: 'server',
    label: conn.name,
    count: null,
    expandable: true,
    node: { kind: 'server' },
  };
}

export interface DeleteResult {
  sql: string;
  applied: number | null;
  undoId: string | null;
}

export interface SchemaTable {
  name: string;
  columns: string[];
}

/** 新增表时的一列定义 */
export interface NewColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  comment?: string | null;
}

/** 结构操作（建表 / 删表 / 清表 / 批量）执行结果 */
export interface StructOpResult {
  sql: string;
  applied?: number | null;
}
