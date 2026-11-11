//! Tauri 命令层：连接配置、连接池、执行中的查询、删除快照都集中在这里。
//!
//! 前端通过 `invoke('命令名', 参数)` 调到这里；命令内部返回的错误已经是
//! 中文可读文案（`db::friendly_error` 处理过），前端直接展示即可。
//! 连接池按 `conn_id|database` 缓存：同一个连接配置切换到别的库时另开一个池。


mod db;
mod model;
mod store;

use model::*;
use sqlx::{Acquire, AnyPool, Connection, Row};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// 应用级共享状态：Tauri 启动时注入，命令通过 `State<'_, AppCtx>` 取用。
pub struct AppCtx {
    configs: Mutex<Vec<ConnectionConfig>>,
    vault: store::Vault,
    pools: Mutex<HashMap<String, AnyPool>>,
    /// 正在执行的查询：pool_key -> (方言, 后端连接 id)，用于取消
    running: Mutex<HashMap<String, (String, i64)>>,
    /// 最近几次删除的快照，用于「撤销删除」（最多保留 5 条）
    undo: Mutex<Vec<UndoEntry>>,
}

#[derive(Clone)]
struct UndoEntry {
    id: String,
    conn_id: String,
    database: Option<String>,
    /// 完整可执行的 INSERT 语句
    inserts: Vec<String>,
    /// 操作文案（「删除这一行」等），目前只用于留痕 / 后续展示
    #[allow(dead_code)]
    label: String,
}

const UNDO_LIMIT: usize = 5;

impl AppCtx {
    fn find(&self, id: &str) -> Result<ConnectionConfig, String> {
        let list = self.configs.lock().map_err(|e| e.to_string())?;
        list.iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| format!("连接不存在: {id}"))
    }
}

/// 连接池的缓存键：同一个连接配置 + 不同的库（PG 切库）各自一个池。
fn pool_key(conn_id: &str, database: Option<&str>) -> String {
    format!("{}|{}", conn_id, database.unwrap_or(""))
}

/// 取连接池：命中缓存直接复用，否则读钥匙串密码后新建并写回缓存。
async fn pool_for(
    state: &AppCtx,
    conn_id: &str,
    cfg: &ConnectionConfig,
    database: Option<&str>,
) -> Result<AnyPool, String> {
    let key = pool_key(conn_id, database);
    if let Ok(cache) = state.pools.lock() {
        if let Some(pool) = cache.get(&key) {
            return Ok(pool.clone());
        }
    }
    let pw = state.vault.get(conn_id);
    let pool = db::connect(cfg, pw.as_deref(), database).await?;
    if let Ok(mut cache) = state.pools.lock() {
        cache.insert(key, pool.clone());
    }
    Ok(pool)
}

/// 当前应用版本（编译时取自 Cargo.toml，构建前由脚本与 package.json 同步）。
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 已保存的连接列表；密码不在其中，只有 `has_password` 标记。
#[tauri::command]
fn connection_list(state: State<'_, AppCtx>) -> Result<Vec<ConnectionConfig>, String> {
    let list = state.configs.lock().map_err(|e| e.to_string())?;
    Ok(list.clone())
}

/// 新增或更新连接。id 为空时生成 UUID；传了密码就写进钥匙串，
/// 没传且原本有密码时保持原密码（编辑连接不必每次重输）。
#[tauri::command]
async fn connection_save(
    app: AppHandle,
    state: State<'_, AppCtx>,
    mut conn: ConnectionConfig,
    password: Option<String>,
) -> Result<ConnectionConfig, String> {
    if conn.id.trim().is_empty() {
        conn.id = uuid::Uuid::new_v4().to_string();
    }
    if let Some(pw) = password.as_deref().filter(|s| !s.is_empty()) {
        state.vault.set(&conn.id, pw);
        conn.has_password = true;
    } else if conn.has_password {
        // 保留原有密码
    }
    {
        let mut list = state.configs.lock().map_err(|e| e.to_string())?;
        match list.iter_mut().find(|c| c.id == conn.id) {
            Some(slot) => *slot = conn.clone(),
            None => list.push(conn.clone()),
        }
        store::save(&app, &list)?;
    }
    Ok(conn)
}

/// 删除连接：同时清掉配置、钥匙串里的密码与这个连接的所有连接池。
#[tauri::command]
fn connection_delete(app: AppHandle, state: State<'_, AppCtx>, id: String) -> Result<(), String> {
    {
        let mut list = state.configs.lock().map_err(|e| e.to_string())?;
        list.retain(|c| c.id != id);
        store::save(&app, &list)?;
    }
    state.vault.remove(&id);
    if let Ok(mut cache) = state.pools.lock() {
        let keys: Vec<String> = cache
            .keys()
            .filter(|k| k.starts_with(&format!("{id}|")))
            .cloned()
            .collect();
        cache.retain(|k, _| !k.starts_with(&format!("{id}|")));
        let _ = keys;
    }
    Ok(())
}

/// 试连接：返回服务端版本与握手耗时，不落配置、不改缓存池。
#[tauri::command]
async fn connection_test(
    state: State<'_, AppCtx>,
    conn: ConnectionConfig,
    password: Option<String>,
) -> Result<TestResult, String> {
    let pw = if password.as_deref().filter(|s| !s.is_empty()).is_some() {
        password
    } else if !conn.id.is_empty() {
        state.vault.get(&conn.id)
    } else {
        None
    };
    db::test(&conn, pw.as_deref()).await
}

/// 展开结构树的一层（库 / schema / 表分组 / 表列表）。
#[tauri::command]
async fn explorer_children(
    state: State<'_, AppCtx>,
    conn_id: String,
    node: NodeRef,
) -> Result<Vec<TreeNode>, String> {
    let cfg = state.find(&conn_id)?;
    let db_hint = match node.kind.as_str() {
        "database" | "schema" | "group" | "table" | "view" => node.database.as_deref(),
        _ => None,
    };
    let pool = pool_for(&state, &conn_id, &cfg, db_hint).await?;
    db::children(&cfg, &pool, &node).await
}

/// 表字段元数据：类型、可空、默认值、主键、注释。
#[tauri::command]
async fn table_columns(
    state: State<'_, AppCtx>,
    conn_id: String,
    node: NodeRef,
) -> Result<Vec<ColumnMeta>, String> {
    let cfg = state.find(&conn_id)?;
    let pool = pool_for(&state, &conn_id, &cfg, node.database.as_deref()).await?;
    db::columns(&cfg, &pool, &node).await
}

/// 分页取表数据，带排序与快速筛选；返回结果同时包含筛选后的总行数。
#[tauri::command]
async fn table_rows(
    state: State<'_, AppCtx>,
    conn_id: String,
    node: NodeRef,
    limit: u32,
    offset: u32,
    sort: Option<String>,
    desc: Option<bool>,
    filter: Option<String>,
) -> Result<ResultSet, String> {
    let cfg = state.find(&conn_id)?;
    let pool = pool_for(&state, &conn_id, &cfg, node.database.as_deref()).await?;
    db::rows(
        &cfg,
        &pool,
        &node,
        limit,
        offset,
        sort.as_deref(),
        desc.unwrap_or(false),
        filter.as_deref(),
    )
    .await
}

/// 执行编辑器里的 SQL：整体包在一个事务里，成功后提交，失败自动回滚。
/// 执行前登记后端连接 id，供 `sql_cancel` 从另一条连接下发取消。
#[tauri::command]
async fn sql_execute(
    state: State<'_, AppCtx>,
    conn_id: String,
    database: Option<String>,
    sql: String,
) -> Result<SqlResult, String> {
    let cfg = state.find(&conn_id)?;
    let key = pool_key(&conn_id, database.as_deref());
    let allow_write = !cfg.read_only.unwrap_or(false);
    let kind = cfg.kind.clone();

    // MySQL 走原生驱动执行：`sqlx::Any` 无法映射 MySQL 的 TIMESTAMP/DATETIME，
    // 否则 `SELECT *` 一旦命中这类列就会整条语句报错（界面表现为「执行后没变化」）。
    if kind == "mysql" {
        let pw = state.vault.get(&conn_id);
        let url = db::build_url(&cfg, pw.as_deref(), database.as_deref())?;
        let mut conn = sqlx::MySqlConnection::connect(&url)
            .await
            .map_err(|e| format!("获取连接失败：{e}"))?;
        let backend_id = sqlx::query("select connection_id()")
            .fetch_one(&mut conn)
            .await
            .ok()
            .and_then(|r| r.try_get::<i64, _>(0).ok());
        if let Some(id) = backend_id {
            if let Ok(mut map) = state.running.lock() {
                map.insert(key.clone(), (kind.clone(), id));
            }
        }
        let outcome = async {
            let mut tx = sqlx::Connection::begin(&mut conn).await.map_err(|e| format!("开启事务失败：{e}"))?;
            let res = db::execute_on_mysql(&mut *tx, &sql, allow_write).await;
            match res {
                Ok(r) => {
                    tx.commit().await.map_err(|e| format!("提交事务失败：{e}"))?;
                    Ok(r)
                }
                Err(e) => Err(e),
            }
        }
        .await;
        if let Ok(mut map) = state.running.lock() {
            map.remove(&key);
        }
        return outcome;
    }

    let pool = pool_for(&state, &conn_id, &cfg, database.as_deref()).await?;

    let mut conn = pool
        .acquire()
        .await
        .map_err(|e| format!("获取连接失败：{e}"))?;

    // 记下后端连接 id，供 sql_cancel 使用（SQLite 没有这个概念）
    let backend_id = match kind.as_str() {
        "postgres" => sqlx::query("select pg_backend_pid()")
            .fetch_one(&mut *conn)
            .await
            .ok()
            .and_then(|r| r.try_get::<i64, _>(0).ok()),
        "mysql" => sqlx::query("select connection_id()")
            .fetch_one(&mut *conn)
            .await
            .ok()
            .and_then(|r| r.try_get::<i64, _>(0).ok()),
        _ => None,
    };
    if let Some(id) = backend_id {
        if let Ok(mut map) = state.running.lock() {
            map.insert(key.clone(), (kind.clone(), id));
        }
    }

    let outcome = async {
        let mut tx = conn.begin().await.map_err(|e| format!("开启事务失败：{e}"))?;
        let res = db::execute_on(&mut *tx, &sql, allow_write).await;
        match res {
            Ok(r) => {
                tx.commit().await.map_err(|e| format!("提交事务失败：{e}"))?;
                Ok(r)
            }
            Err(e) => Err(e),
        }
    }
    .await;

    if let Ok(mut map) = state.running.lock() {
        map.remove(&key);
    }
    outcome
}

/// 取消正在执行的查询：PG 走 `pg_cancel_backend`，MySQL 走 `KILL QUERY`。
/// SQLite 是进程内文件库，没有可取消的后端查询，明确返回不支持。
#[tauri::command]
async fn sql_cancel(
    state: State<'_, AppCtx>,
    conn_id: String,
    database: Option<String>,
) -> Result<String, String> {
    let cfg = state.find(&conn_id)?;
    let key = pool_key(&conn_id, database.as_deref());
    let target = {
        let map = state.running.lock().map_err(|e| e.to_string())?;
        map.get(&key).cloned()
    };
    let (kind, id) = target.ok_or_else(|| "当前没有正在执行的查询".to_string())?;
    let pool = pool_for(&state, &conn_id, &cfg, database.as_deref()).await?;
    let mut conn = pool
        .acquire()
        .await
        .map_err(|e| format!("获取连接失败：{e}"))?;

    match kind.as_str() {
        "postgres" => {
            sqlx::query("select pg_cancel_backend($1)")
                .bind(id as i32)
                .execute(&mut *conn)
                .await
                .map_err(|e| format!("取消失败：{e}"))?;
            Ok("已发送取消请求".to_string())
        }
        "mysql" => {
            sqlx::query(&format!("KILL QUERY {id}"))
                .execute(&mut *conn)
                .await
                .map_err(|e| format!("取消失败：{e}"))?;
            Ok("已发送取消请求".to_string())
        }
        _ => Err("SQLite 不支持取消正在执行的查询".to_string()),
    }
}

/// 表索引列表（含主键与唯一索引）。
#[tauri::command]
async fn table_indexes(
    state: State<'_, AppCtx>,
    conn_id: String,
    node: NodeRef,
) -> Result<Vec<IndexMeta>, String> {
    let cfg = state.find(&conn_id)?;
    let pool = pool_for(&state, &conn_id, &cfg, node.database.as_deref()).await?;
    db::indexes(&cfg, &pool, &node).await
}

/// 表外键列表。
#[tauri::command]
async fn table_foreign_keys(
    state: State<'_, AppCtx>,
    conn_id: String,
    node: NodeRef,
) -> Result<Vec<ForeignKeyMeta>, String> {
    let cfg = state.find(&conn_id)?;
    let pool = pool_for(&state, &conn_id, &cfg, node.database.as_deref()).await?;
    db::foreign_keys(&cfg, &pool, &node).await
}

/// 建表语句；数据库没有原生 DDL 接口时按字段元数据拼装并标记 `generated`。
#[tauri::command]
async fn table_ddl(
    state: State<'_, AppCtx>,
    conn_id: String,
    node: NodeRef,
) -> Result<DdlResult, String> {
    let cfg = state.find(&conn_id)?;
    let pool = pool_for(&state, &conn_id, &cfg, node.database.as_deref()).await?;
    db::ddl(&cfg, &pool, &node).await
}

/// 单元格编辑的预览：只生成 SQL，不执行。
#[tauri::command]
async fn row_update_preview(
    state: State<'_, AppCtx>,
    conn_id: String,
    node: NodeRef,
    keys: Vec<KeyValue>,
    column: String,
    value: Option<String>,
) -> Result<UpdateResult, String> {
    let cfg = state.find(&conn_id)?;
    let pool = pool_for(&state, &conn_id, &cfg, node.database.as_deref()).await?;
    let sql = db::update_sql(&cfg, &pool, &node, &keys, &column, value.as_deref()).await?;
    Ok(UpdateResult { sql, applied: None })
}

/// 单元格编辑的执行：只读连接直接拒绝，SQL 与预览走同一个生成函数。
#[tauri::command]
async fn row_update_apply(
    state: State<'_, AppCtx>,
    conn_id: String,
    node: NodeRef,
    keys: Vec<KeyValue>,
    column: String,
    value: Option<String>,
) -> Result<UpdateResult, String> {
    let cfg = state.find(&conn_id)?;
    if cfg.read_only.unwrap_or(false) {
        return Err("当前连接标记为「只读」，已阻止写操作".to_string());
    }
    let pool = pool_for(&state, &conn_id, &cfg, node.database.as_deref()).await?;
    let sql = db::update_sql(&cfg, &pool, &node, &keys, &column, value.as_deref()).await?;
    let applied = db::update_apply(&pool, &sql).await?;
    Ok(UpdateResult { sql, applied: Some(applied) })
}

/// 新增行的预览：只拼 INSERT，不执行。
#[tauri::command]
async fn row_insert_preview(
    state: State<'_, AppCtx>,
    conn_id: String,
    node: NodeRef,
    values: Vec<KeyValue>,
) -> Result<UpdateResult, String> {
    let cfg = state.find(&conn_id)?;
    let pool = pool_for(&state, &conn_id, &cfg, node.database.as_deref()).await?;
    let sql = db::insert_sql(&cfg, &pool, &node, &values).await?;
    Ok(UpdateResult { sql, applied: None })
}

/// 新增行的执行。
#[tauri::command]
async fn row_insert_apply(
    state: State<'_, AppCtx>,
    conn_id: String,
    node: NodeRef,
    values: Vec<KeyValue>,
) -> Result<UpdateResult, String> {
    let cfg = state.find(&conn_id)?;
    if cfg.read_only.unwrap_or(false) {
        return Err("当前连接标记为「只读」，已阻止写操作".to_string());
    }
    let pool = pool_for(&state, &conn_id, &cfg, node.database.as_deref()).await?;
    let sql = db::insert_sql(&cfg, &pool, &node, &values).await?;
    let applied = db::update_apply(&pool, &sql).await?;
    Ok(UpdateResult {
        sql,
        applied: Some(applied),
    })
}

/// 删除单行的预览：只生成 DELETE。
#[tauri::command]
async fn row_delete_preview(
    state: State<'_, AppCtx>,
    conn_id: String,
    node: NodeRef,
    keys: Vec<KeyValue>,
) -> Result<DeleteResult, String> {
    let cfg = state.find(&conn_id)?;
    let pool = pool_for(&state, &conn_id, &cfg, node.database.as_deref()).await?;
    let sql = db::delete_sql(&cfg, &pool, &node, &keys).await?;
    Ok(DeleteResult { sql, applied: None, undo_id: None })
}

/// 删除单行：执行前先拍 INSERT 快照，成功后把快照登记进撤销栈。
#[tauri::command]
async fn row_delete_apply(
    state: State<'_, AppCtx>,
    conn_id: String,
    node: NodeRef,
    keys: Vec<KeyValue>,
) -> Result<DeleteResult, String> {
    let cfg = state.find(&conn_id)?;
    if cfg.read_only.unwrap_or(false) {
        return Err("当前连接标记为「只读」，已阻止写操作".to_string());
    }
    let pool = pool_for(&state, &conn_id, &cfg, node.database.as_deref()).await?;
    let sql = db::delete_sql(&cfg, &pool, &node, &keys).await?;
    let snapshot = db::snapshot_inserts(&cfg, &pool, &node, &[keys]).await.unwrap_or_default();
    let applied = db::update_apply(&pool, &sql).await?;
    let undo_id = push_undo(&state, &conn_id, &node, snapshot, "删除这一行");
    Ok(DeleteResult {
        sql,
        applied: Some(applied),
        undo_id,
    })
}

/// 批量删除的预览：所有行合成一条 DELETE（主键条件用 OR 连接）。
#[tauri::command]
async fn row_delete_many_preview(
    state: State<'_, AppCtx>,
    conn_id: String,
    node: NodeRef,
    rows: Vec<Vec<KeyValue>>,
) -> Result<DeleteResult, String> {
    let cfg = state.find(&conn_id)?;
    let pool = pool_for(&state, &conn_id, &cfg, node.database.as_deref()).await?;
    let sql = db::delete_many_sql(&cfg, &pool, &node, &rows).await?;
    Ok(DeleteResult { sql, applied: None, undo_id: None })
}

/// 批量删除的执行：同样先拍快照，再删除。
#[tauri::command]
async fn row_delete_many_apply(
    state: State<'_, AppCtx>,
    conn_id: String,
    node: NodeRef,
    rows: Vec<Vec<KeyValue>>,
) -> Result<DeleteResult, String> {
    let cfg = state.find(&conn_id)?;
    if cfg.read_only.unwrap_or(false) {
        return Err("当前连接标记为「只读」，已阻止写操作".to_string());
    }
    let pool = pool_for(&state, &conn_id, &cfg, node.database.as_deref()).await?;
    let sql = db::delete_many_sql(&cfg, &pool, &node, &rows).await?;
    let snapshot = db::snapshot_inserts(&cfg, &pool, &node, &rows).await.unwrap_or_default();
    let applied = db::update_apply(&pool, &sql).await?;
    let undo_id = push_undo(&state, &conn_id, &node, snapshot, "删除选中的行");
    Ok(DeleteResult { sql, applied: Some(applied as u64), undo_id })
}

/// 把一次删除的快照压入撤销栈，超过上限（5 条）就丢掉最旧的。
fn push_undo(
    state: &State<'_, AppCtx>,
    conn_id: &str,
    node: &NodeRef,
    inserts: Vec<String>,
    label: &str,
) -> Option<String> {
    if inserts.is_empty() {
        return None;
    }
    let id = uuid::Uuid::new_v4().to_string();
    if let Ok(mut list) = state.undo.lock() {
        list.push(UndoEntry {
            id: id.clone(),
            conn_id: conn_id.to_string(),
            database: node.database.clone(),
            inserts,
            label: label.to_string(),
        });
        if list.len() > UNDO_LIMIT {
            list.remove(0);
        }
    }
    Some(id)
}

/// 整库表结构，供 SQL 编辑器补全（跨表 / join 也能补出字段）。
#[tauri::command]
async fn schema_map(
    state: State<'_, AppCtx>,
    conn_id: String,
    node: NodeRef,
) -> Result<Vec<SchemaTable>, String> {
    let cfg = state.find(&conn_id)?;
    let pool = pool_for(&state, &conn_id, &cfg, node.database.as_deref()).await?;
    db::schema_map(&cfg, &pool, &node).await
}

/// 撤销删除：取出快照并在一个连接上重放这些 INSERT，返回恢复的行数。
/// 条目取走后即失效，重复点击会提示「已经失效」。
#[tauri::command]
async fn row_undo_delete(
    state: State<'_, AppCtx>,
    undo_id: String,
) -> Result<u64, String> {
    let entry = {
        let mut list = state.undo.lock().map_err(|e| e.to_string())?;
        match list.iter().position(|e| e.id == undo_id) {
            Some(i) => list.remove(i),
            None => return Err("这一条撤销记录已经失效".to_string()),
        }
    };
    if entry.inserts.is_empty() {
        return Err("没有可恢复的数据".to_string());
    }
    let cfg = state.find(&entry.conn_id)?;
    let pool = pool_for(&state, &entry.conn_id, &cfg, entry.database.as_deref()).await?;
    let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
    let sql = entry.inserts.join("; ");
    let rs = db::execute_on(&mut conn, &sql, true).await?;
    Ok(rs.affected.unwrap_or(0))
}

/// 视图 / 函数 / 存储过程 / 触发器的定义文本。
#[tauri::command]
async fn object_ddl(
    state: State<'_, AppCtx>,
    conn_id: String,
    node: NodeRef,
) -> Result<DdlResult, String> {
    let cfg = state.find(&conn_id)?;
    let pool = pool_for(&state, &conn_id, &cfg, node.database.as_deref()).await?;
    db::object_ddl(&cfg, &pool, &node).await
}

/// 导出当前表数据到 CSV（默认上限 10 万行，落盘路径由后端决定）。
#[tauri::command]
async fn export_csv(
    state: State<'_, AppCtx>,
    conn_id: String,
    node: NodeRef,
    limit: Option<u32>,
) -> Result<ExportResult, String> {
    let cfg = state.find(&conn_id)?;
    let pool = pool_for(&state, &conn_id, &cfg, node.database.as_deref()).await?;
    db::export_csv(&cfg, &pool, &node, limit.unwrap_or(100_000)).await
}

/// 关闭并丢弃这个连接的全部连接池（前端目前未直接调用）。
#[tauri::command]
async fn close_connection(state: State<'_, AppCtx>, conn_id: String) -> Result<(), String> {
    let prefix = format!("{conn_id}|");
    let pools: Vec<AnyPool> = {
        let mut cache = state.pools.lock().map_err(|e| e.to_string())?;
        let keys: Vec<String> = cache
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        keys.into_iter().filter_map(|k| cache.remove(&k)).collect()
    };
    for pool in pools {
        pool.close().await;
    }
    Ok(())
}

/// 应用入口：注册驱动、装载配置、注册全部命令。
/// `install_default_drivers()` 必须先跑，否则 `Any` 驱动不认识任何方言。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    sqlx::any::install_default_drivers();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let configs = store::load(&app.handle());
            app.manage(AppCtx {
                configs: Mutex::new(configs),
                vault: store::Vault::new(),
                pools: Mutex::new(HashMap::new()),
                running: Mutex::new(HashMap::new()),
                undo: Mutex::new(Vec::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            connection_list,
            connection_save,
            connection_delete,
            connection_test,
            explorer_children,
            table_columns,
            table_rows,
            table_indexes,
            table_foreign_keys,
            table_ddl,
            sql_execute,
            sql_cancel,
            row_update_preview,
            row_update_apply,
            row_insert_preview,
            row_insert_apply,
            row_delete_preview,
            row_delete_apply,
            row_delete_many_preview,
            row_delete_many_apply,
            row_undo_delete,
            schema_map,
            object_ddl,
            export_csv,
            close_connection
        ])
        .run(tauri::generate_context!())
        .expect("error while running SQLL");
}
