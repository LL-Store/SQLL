/**
 * 前端访问后端的唯一出口：把每个 Tauri 命令包成一个有类型的方法。
 *
 * 参数名与 Rust 命令签名保持一致（Tauri 会做 camelCase → snake_case 映射）；
 * 浏览器里预览 UI 时没有 Tauri 运行时，统一抛出一句可读提示，
 * 需要真数据库能力请跑 `npm run app:dev`。
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  ColumnMeta,
  ConnectionConfig,
  DdlResult,
  DeleteResult,
  ExportResult,
  ForeignKeyMeta,
  KeyValue,
  UpdateResult,
  IndexMeta,
  NodeRef,
  ResultSet,
  SchemaTable,
  SqlResult,
  TestResult,
  TreeNode,
} from '@/types';

/** 浏览器里预览 UI 时没有 Tauri 运行时，统一给一句可读的提示 */
export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri) {
    throw new Error('当前是浏览器预览，数据库能力需要运行桌面端（npm run app:dev）');
  }
  return invoke<T>(cmd, args);
}

export const api = {
  listConnections: () => call<ConnectionConfig[]>('connection_list'),
  saveConnection: (conn: ConnectionConfig, password?: string) =>
    call<ConnectionConfig>('connection_save', { conn, password: password ?? null }),
  deleteConnection: (id: string) => call<void>('connection_delete', { id }),
  testConnection: (conn: ConnectionConfig, password?: string) =>
    call<TestResult>('connection_test', { conn, password: password ?? null }),
  children: (connId: string, node: NodeRef) =>
    call<TreeNode[]>('explorer_children', { connId, node }),
  columns: (connId: string, node: NodeRef) =>
    call<ColumnMeta[]>('table_columns', { connId, node }),
  rows: (
    connId: string,
    node: NodeRef,
    limit: number,
    offset: number,
    sort?: string | null,
    desc?: boolean,
    filter?: string,
  ) =>
    call<ResultSet>('table_rows', {
      connId,
      node,
      limit,
      offset,
      sort: sort ?? null,
      desc: desc ?? false,
      filter: filter && filter.trim() ? filter : null,
    }),
  execute: (connId: string, database: string | null, sql: string) =>
    call<SqlResult>('sql_execute', { connId, database, sql }),
  updatePreview: (
    connId: string,
    node: NodeRef,
    keys: KeyValue[],
    column: string,
    value: string | null,
  ) => call<UpdateResult>('row_update_preview', { connId, node, keys, column, value }),
  applyUpdate: (
    connId: string,
    node: NodeRef,
    keys: KeyValue[],
    column: string,
    value: string | null,
  ) => call<UpdateResult>('row_update_apply', { connId, node, keys, column, value }),
  insertPreview: (connId: string, node: NodeRef, values: KeyValue[]) =>
    call<UpdateResult>('row_insert_preview', { connId, node, values }),
  insertApply: (connId: string, node: NodeRef, values: KeyValue[]) =>
    call<UpdateResult>('row_insert_apply', { connId, node, values }),
  deletePreview: (connId: string, node: NodeRef, keys: KeyValue[]) =>
    call<DeleteResult>('row_delete_preview', { connId, node, keys }),
  deleteApply: (connId: string, node: NodeRef, keys: KeyValue[]) =>
    call<DeleteResult>('row_delete_apply', { connId, node, keys }),
  deleteManyPreview: (connId: string, node: NodeRef, rows: KeyValue[][]) =>
    call<DeleteResult>('row_delete_many_preview', { connId, node, rows }),
  deleteManyApply: (connId: string, node: NodeRef, rows: KeyValue[][]) =>
    call<DeleteResult>('row_delete_many_apply', { connId, node, rows }),
  undoDelete: (undoId: string) => call<number>('row_undo_delete', { undoId }),
  schemaMap: (connId: string, node: NodeRef) =>
    call<SchemaTable[]>('schema_map', { connId, node }),
  objectDdl: (connId: string, node: NodeRef) =>
    call<DdlResult>('object_ddl', { connId, node }),
  cancelSql: (connId: string, database: string | null) =>
    call<string>('sql_cancel', { connId, database }),
  exportCsv: (connId: string, node: NodeRef, limit?: number) =>
    call<ExportResult>('export_csv', { connId, node, limit: limit ?? 100000 }),
  indexes: (connId: string, node: NodeRef) =>
    call<IndexMeta[]>('table_indexes', { connId, node }),
  foreignKeys: (connId: string, node: NodeRef) =>
    call<ForeignKeyMeta[]>('table_foreign_keys', { connId, node }),
  ddl: (connId: string, node: NodeRef) => call<DdlResult>('table_ddl', { connId, node }),
};
