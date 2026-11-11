//! 三种数据库的统一适配层。
//!
//! 全部走 sqlx 的 `Any` 驱动，因此这里的规则是统一的：
//! - 取数时非数值列先 CAST 成文本再读，避免 Any 解码 PG 的 `name` / `jsonb` /
//!   自定义类型失败；CAST 必须 `as 原列名`，否则列名会变成表达式文本。
//! - 生成写 SQL 时值走字面量而不是绑定参数：跨方言行为一致，也便于先给用户确认再执行。
//! - 标识符按方言加引号（MySQL 反引号，其余双引号），外部字符串一律经过
//!   `ident` / `lit` / `quote_literal`，不直接把用户输入拼进语句。

use crate::model::*;
use sqlx::any::{AnyPoolOptions, AnyRow};
use sqlx::{AnyPool, Column, Row, ValueRef};
use std::time::{Duration, Instant};

/* ---------------- URL / 转义 ---------------- */

fn enc(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            ':' | '/' | '?' | '#' | '[' | ']' | '@' | '!' | '$' | '&' | '\'' | '(' | ')' | '*'
            | '+' | ',' | ';' | '=' | '%' | ' ' => format!("%{:02X}", c as u32),
            _ => c.to_string(),
        })
        .collect()
}

pub fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn ident(kind: &str, s: &str) -> String {
    if kind == "mysql" {
        format!("`{}`", s.replace('`', "``"))
    } else {
        format!("\"{}\"", s.replace('"', "\"\""))
    }
}

fn mysql_ssl(mode: &str) -> &'static str {
    match mode {
        "preferred" => "preferred",
        "required" => "required",
        "verify-ca" => "verify_ca",
        "verify-full" => "verify_identity",
        _ => "disabled",
    }
}

fn pg_ssl(mode: &str) -> &'static str {
    match mode {
        "preferred" => "prefer",
        "required" => "require",
        "verify-ca" => "verify-ca",
        "verify-full" => "verify-full",
        _ => "disable",
    }
}

/// 拼接 sqlx 连接串：三种方言的 URL 形态、SSL 参数名都不一样。
/// `database` 用于 PG 临时切库（同一个连接配置换库要另建池）。
pub fn build_url(cfg: &ConnectionConfig, password: Option<&str>, database: Option<&str>) -> Result<String, String> {
    match cfg.kind.as_str() {
        "mysql" => {
            let user = cfg.user.clone().unwrap_or_default();
            let auth = if user.is_empty() {
                String::new()
            } else if let Some(pw) = password {
                format!("{}:{}@", enc(&user), enc(pw))
            } else {
                format!("{}@", enc(&user))
            };
            let db = database.map(|s| s.to_string()).or_else(|| cfg.database.clone()).unwrap_or_default();
            let mode = mysql_ssl(&cfg.ssl_mode);
            let mut url = format!(
                "mysql://{auth}{}:{}/{db}?ssl-mode={mode}",
                cfg.host, cfg.port
            );
            if let Some(ca) = cfg.ca_path.as_deref().filter(|s| !s.is_empty()) {
                url.push_str(&format!("&ssl-ca={}", enc(ca)));
            }
            Ok(url)
        }
        "postgres" => {
            let user = cfg.user.clone().unwrap_or_default();
            let auth = if user.is_empty() {
                String::new()
            } else if let Some(pw) = password {
                format!("{}:{}@", enc(&user), enc(pw))
            } else {
                format!("{}@", enc(&user))
            };
            let db = database
                .map(|s| s.to_string())
                .or_else(|| cfg.database.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "postgres".to_string());
            let mut url = format!(
                "postgres://{auth}{}:{}/{db}?sslmode={}",
                cfg.host,
                cfg.port,
                pg_ssl(&cfg.ssl_mode)
            );
            if let Some(ca) = cfg.ca_path.as_deref().filter(|s| !s.is_empty()) {
                url.push_str(&format!("&sslrootcert={}", enc(ca)));
            }
            Ok(url)
        }
        "sqlite" => {
            let path = cfg
                .file_path
                .clone()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "SQLite 需要选择数据库文件".to_string())?;
            Ok(format!("sqlite:{}?mode=rwc", path))
        }
        other => Err(format!("不支持的数据库类型: {other}")),
    }
}

/// 建连接池。池上限 4 条：桌面端够用，也不会把服务端连接数吃光。
pub async fn connect(
    cfg: &ConnectionConfig,
    password: Option<&str>,
    database: Option<&str>,
) -> Result<AnyPool, String> {
    let url = build_url(cfg, password, database)?;
    AnyPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(8))
        .connect(&url)
        .await
        .map_err(|e| friendly_error(&e.to_string()))
}

/// 把驱动返回的原始错误翻成一句中文：用户看到的是「认证失败」，而不是一段英文堆栈。
/// 未识别的错误原样返回，避免把有用的细节吞掉。
fn friendly_error(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("canceling statement") || lower.contains("query execution was interrupted") {
        return "查询已取消".to_string();
    }
    if lower.contains("password authentication failed") || lower.contains("access denied") {
        return "认证失败：用户名或密码不正确".to_string();
    }
    if lower.contains("connection refused") || lower.contains("os error 61") {
        return "无法连接：请检查主机与端口，以及数据库是否已启动".to_string();
    }
    if lower.contains("unknown database") || lower.contains("does not exist") {
        return "数据库不存在：请检查库名".to_string();
    }
    if lower.contains("certificate") || lower.contains("tls") {
        return format!("SSL 握手失败：{raw}");
    }
    raw.to_string()
}

pub async fn server_version(pool: &AnyPool, kind: &str) -> Result<String, String> {
    let sql = match kind {
        "postgres" => "show server_version",
        "sqlite" => "select sqlite_version()",
        _ => "select version()",
    };
    let row = sqlx::query(sql)
        .fetch_one(pool)
        .await
        .map_err(|e| friendly_error(&e.to_string()))?;
    Ok(row.try_get::<String, _>(0).unwrap_or_default())
}

pub async fn test(cfg: &ConnectionConfig, password: Option<&str>) -> Result<TestResult, String> {
    let start = Instant::now();
    let pool = connect(cfg, password, None).await?;
    let version = server_version(&pool, &cfg.kind).await?;
    let latency = start.elapsed().as_millis();
    pool.close().await;
    Ok(TestResult {
        version,
        latency_ms: latency,
    })
}

async fn texts(pool: &AnyPool, sql: &str) -> Result<Vec<String>, String> {
    let rows = sqlx::query(sql)
        .fetch_all(pool)
        .await
        .map_err(|e| friendly_error(&e.to_string()))?;
    Ok(rows
        .iter()
        .filter_map(|r| r.try_get::<String, _>(0).ok())
        .collect())
}

async fn count(pool: &AnyPool, sql: &str) -> i64 {
    sqlx::query(sql)
        .fetch_one(pool)
        .await
        .ok()
        .and_then(|r| r.try_get::<i64, _>(0).ok())
        .unwrap_or(0)
}

fn node_id(kind: &str, db: Option<&str>, schema: Option<&str>, name: &str) -> String {
    format!(
        "{}|{}|{}|{}",
        kind,
        db.unwrap_or(""),
        schema.unwrap_or(""),
        name
    )
}

fn group_node(kind: &str, label: &str, count: i64, db: Option<&str>, schema: Option<&str>, group: &str) -> TreeNode {
    TreeNode {
        id: format!("group|{}|{}|{}", db.unwrap_or(""), schema.unwrap_or(""), group),
        kind: kind.to_string(),
        label: label.to_string(),
        count: Some(count),
        expandable: count > 0,
        node: NodeRef {
            kind: "group".into(),
            database: db.map(|s| s.to_string()),
            schema: schema.map(|s| s.to_string()),
            name: None,
            group: Some(group.to_string()),
        },
    }
}

/// 数据库 → 分组
async fn groups(
    pool: &AnyPool,
    kind: &str,
    db: Option<&str>,
    schema: Option<&str>,
) -> Result<Vec<TreeNode>, String> {
    let mut out = Vec::new();
    match kind {
        "mysql" => {
            let d = db.unwrap_or_default();
            let t = count(
                pool,
                &format!(
                    "select count(*) from information_schema.tables where table_schema={} and table_type='BASE TABLE'",
                    lit(d)
                ),
            )
            .await;
            let v = count(
                pool,
                &format!(
                    "select count(*) from information_schema.tables where table_schema={} and table_type='VIEW'",
                    lit(d)
                ),
            )
            .await;
            let f = count(
                pool,
                &format!(
                    "select count(*) from information_schema.routines where routine_schema={} and routine_type='FUNCTION'",
                    lit(d)
                ),
            )
            .await;
            let p = count(
                pool,
                &format!(
                    "select count(*) from information_schema.routines where routine_schema={} and routine_type='PROCEDURE'",
                    lit(d)
                ),
            )
            .await;
            let g = count(
                pool,
                &format!(
                    "select count(*) from information_schema.triggers where trigger_schema={}",
                    lit(d)
                ),
            )
            .await;
            out.push(group_node("group", "表", t, db, None, "table"));
            out.push(group_node("group", "视图", v, db, None, "view"));
            out.push(group_node("group", "函数", f, db, None, "function"));
            out.push(group_node("group", "存储过程", p, db, None, "procedure"));
            out.push(group_node("group", "触发器", g, db, None, "trigger"));
        }
        "postgres" => {
            let s = schema.unwrap_or("public");
            let t = count(
                pool,
                &format!(
                    "select count(*) from information_schema.tables where table_schema={} and table_type='BASE TABLE'",
                    lit(s)
                ),
            )
            .await;
            let v = count(
                pool,
                &format!(
                    "select count(*) from information_schema.tables where table_schema={} and table_type='VIEW'",
                    lit(s)
                ),
            )
            .await;
            let f = count(
                pool,
                &format!(
                    "select count(*) from information_schema.routines where routine_schema={} and routine_type='FUNCTION'",
                    lit(s)
                ),
            )
            .await;
            let p = count(
                pool,
                &format!(
                    "select count(*) from information_schema.routines where routine_schema={} and routine_type='PROCEDURE'",
                    lit(s)
                ),
            )
            .await;
            let g = count(
                pool,
                &format!(
                    "select count(*) from information_schema.triggers where trigger_schema={}",
                    lit(s)
                ),
            )
            .await;
            out.push(group_node("group", "表", t, db, schema, "table"));
            out.push(group_node("group", "视图", v, db, schema, "view"));
            out.push(group_node("group", "函数", f, db, schema, "function"));
            out.push(group_node("group", "存储过程", p, db, schema, "procedure"));
            out.push(group_node("group", "触发器", g, db, schema, "trigger"));
        }
        _ => {
            let t = count(
                pool,
                "select count(*) from sqlite_master where type='table' and name not like 'sqlite_%'",
            )
            .await;
            let v = count(pool, "select count(*) from sqlite_master where type='view'").await;
            let g = count(pool, "select count(*) from sqlite_master where type='trigger'").await;
            out.push(group_node("group", "表", t, db, None, "table"));
            out.push(group_node("group", "视图", v, db, None, "view"));
            out.push(group_node("group", "触发器", g, db, None, "trigger"));
        }
    }
    Ok(out)
}

async fn group_items(
    pool: &AnyPool,
    kind: &str,
    db: Option<&str>,
    schema: Option<&str>,
    group: &str,
) -> Result<Vec<TreeNode>, String> {
    let sql: String;
    match kind {
        "mysql" => {
            let d = lit(db.unwrap_or_default());
            sql = match group {
                "table" => format!("select table_name from information_schema.tables where table_schema={d} and table_type='BASE TABLE' order by table_name"),
                "view" => format!("select table_name from information_schema.tables where table_schema={d} and table_type='VIEW' order by table_name"),
                "function" => format!("select routine_name from information_schema.routines where routine_schema={d} and routine_type='FUNCTION' order by routine_name"),
                "procedure" => format!("select routine_name from information_schema.routines where routine_schema={d} and routine_type='PROCEDURE' order by routine_name"),
                _ => format!("select trigger_name from information_schema.triggers where trigger_schema={d} order by trigger_name"),
            };
        }
        "postgres" => {
            let s = lit(schema.unwrap_or("public"));
            sql = match group {
                "table" => format!("select table_name::text from information_schema.tables where table_schema={s} and table_type='BASE TABLE' order by table_name"),
                "view" => format!("select table_name::text from information_schema.tables where table_schema={s} and table_type='VIEW' order by table_name"),
                "function" => format!("select routine_name::text from information_schema.routines where routine_schema={s} and routine_type='FUNCTION' order by routine_name"),
                "procedure" => format!("select routine_name::text from information_schema.routines where routine_schema={s} and routine_type='PROCEDURE' order by routine_name"),
                _ => format!("select trigger_name::text from information_schema.triggers where trigger_schema={s} order by trigger_name"),
            };
        }
        _ => {
            sql = match group {
                "table" => "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name".to_string(),
                "view" => "select name from sqlite_master where type='view' order by name".to_string(),
                _ => "select name from sqlite_master where type='trigger' order by name".to_string(),
            };
        }
    }

    let names = texts(pool, &sql).await?;
    let item_kind = match group {
        "table" => "table",
        "view" => "view",
        "function" => "function",
        "procedure" => "procedure",
        _ => "trigger",
    };
    Ok(names
        .into_iter()
        .map(|name| TreeNode {
            id: node_id(item_kind, db, schema, &name),
            kind: item_kind.to_string(),
            label: name.clone(),
            count: None,
            expandable: false,
            node: NodeRef {
                kind: item_kind.into(),
                database: db.map(|s| s.to_string()),
                schema: schema.map(|s| s.to_string()),
                name: Some(name),
                group: None,
            },
        })
        .collect())
}

pub async fn children(
    cfg: &ConnectionConfig,
    pool: &AnyPool,
    node: &NodeRef,
) -> Result<Vec<TreeNode>, String> {
    match node.kind.as_str() {
        "server" => match cfg.kind.as_str() {
            "mysql" => {
                let names = texts(
                    pool,
                    "select schema_name from information_schema.schemata order by schema_name",
                )
                .await?;
                Ok(names
                    .into_iter()
                    .map(|n| TreeNode {
                        id: node_id("database", Some(&n), None, &n),
                        kind: "database".into(),
                        label: n.clone(),
                        count: None,
                        expandable: true,
                        node: NodeRef {
                            kind: "database".into(),
                            database: Some(n),
                            schema: None,
                            name: None,
                            group: None,
                        },
                    })
                    .collect())
            }
            "postgres" => {
                let names = texts(
                    pool,
                    "select datname::text from pg_database where not datistemplate order by datname",
                )
                .await?;
                Ok(names
                    .into_iter()
                    .map(|n| TreeNode {
                        id: node_id("database", Some(&n), None, &n),
                        kind: "database".into(),
                        label: n.clone(),
                        count: None,
                        expandable: true,
                        node: NodeRef {
                            kind: "database".into(),
                            database: Some(n),
                            schema: None,
                            name: None,
                            group: None,
                        },
                    })
                    .collect())
            }
            _ => {
                let label = cfg
                    .file_path
                    .as_deref()
                    .and_then(|p| std::path::Path::new(p).file_stem().map(|s| s.to_string_lossy().to_string()))
                    .unwrap_or_else(|| "main".to_string());
                Ok(vec![TreeNode {
                    id: node_id("database", Some("main"), None, "main"),
                    kind: "database".into(),
                    label,
                    count: None,
                    expandable: true,
                    node: NodeRef {
                        kind: "database".into(),
                        database: Some("main".into()),
                        schema: None,
                        name: None,
                        group: None,
                    },
                }])
            }
        },
        "database" => {
            if cfg.kind == "postgres" {
                let names = texts(
                    pool,
                    "select nspname::text from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema' order by nspname",
                )
                .await?;
                Ok(names
                    .into_iter()
                    .map(|n| TreeNode {
                        id: node_id("schema", node.database.as_deref(), Some(&n), &n),
                        kind: "schema".into(),
                        label: n.clone(),
                        count: None,
                        expandable: true,
                        node: NodeRef {
                            kind: "schema".into(),
                            database: node.database.clone(),
                            schema: Some(n),
                            name: None,
                            group: None,
                        },
                    })
                    .collect())
            } else {
                groups(pool, &cfg.kind, node.database.as_deref(), None).await
            }
        }
        "schema" => groups(pool, &cfg.kind, node.database.as_deref(), node.schema.as_deref()).await,
        "group" => {
            group_items(
                pool,
                &cfg.kind,
                node.database.as_deref(),
                node.schema.as_deref(),
                node.group.as_deref().unwrap_or("table"),
            )
            .await
        }
        _ => Ok(Vec::new()),
    }
}

pub async fn columns(cfg: &ConnectionConfig, pool: &AnyPool, node: &NodeRef) -> Result<Vec<ColumnMeta>, String> {
    let table = node.name.clone().unwrap_or_default();
    let mut out = Vec::new();

    if cfg.kind == "sqlite" {
        let rows = sqlx::query(&format!("pragma table_info({})", ident("sqlite", &table)))
            .fetch_all(pool)
            .await
            .map_err(|e| friendly_error(&e.to_string()))?;
        for r in rows {
            let name: String = r.try_get("name").unwrap_or_default();
            let type_name: String = r.try_get("type").unwrap_or_default();
            let notnull: i64 = r.try_get("notnull").unwrap_or(0);
            let pk: i64 = r.try_get("pk").unwrap_or(0);
            let dflt: Option<String> = r.try_get("dflt_value").ok();
            out.push(ColumnMeta {
                name,
                type_name,
                nullable: notnull == 0,
                default_value: dflt,
                primary_key: pk > 0,
                comment: None,
            });
        }
        return Ok(out);
    }

    let owner = if cfg.kind == "postgres" {
        node.schema.as_deref().unwrap_or("public")
    } else {
        node.database.as_deref().unwrap_or_default()
    };
    let schema_cond = format!(
        "table_schema={} and table_name={}",
        lit(owner),
        lit(&table)
    );

    let sql = if cfg.kind == "postgres" {
        format!(
            "select column_name::text, data_type::text, is_nullable::text, column_default::text, coalesce(col_description('{}'::regclass, ordinal_position), '')::text as remark from information_schema.columns where {} order by ordinal_position",
            table.replace('\'', "''"),
            schema_cond
        )
    } else {
        format!(
            "select column_name, column_type, is_nullable, column_default, column_comment, column_key from information_schema.columns where {} order by ordinal_position",
            schema_cond
        )
    };

    let rows = sqlx::query(&sql)
        .fetch_all(pool)
        .await
        .map_err(|e| friendly_error(&e.to_string()))?;

    let is_mysql = cfg.kind == "mysql";
    for r in rows {
        out.push(ColumnMeta {
            name: any_text(&r, 0).unwrap_or_default(),
            type_name: any_text(&r, 1).unwrap_or_default(),
            nullable: any_text(&r, 2)
                .map(|s| s.eq_ignore_ascii_case("yes"))
                .unwrap_or(true),
            default_value: any_text(&r, 3),
            // MySQL 的主键信息来自 column_key，其余库在 gather 时单独补
            primary_key: is_mysql && any_text(&r, 5).map(|k| k == "PRI").unwrap_or(false),
            comment: any_text(&r, 4),
        });
    }
    if !is_mysql {
        // PostgreSQL 的主键从 pg_index 补；SQLite 已在 pragma 分支处理
        if let Ok(pk) = primary_keys(cfg, pool, node).await {
            for c in out.iter_mut() {
                c.primary_key = pk.iter().any(|k| k == &c.name);
            }
        }
    }
    Ok(out)
}

fn any_text(row: &AnyRow, i: usize) -> Option<String> {
    if let Ok(v) = row.try_get::<Option<String>, _>(i) {
        return v;
    }
    if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
        return v.map(|b| String::from_utf8_lossy(&b).into_owned());
    }
    None
}

async fn primary_keys(
    cfg: &ConnectionConfig,
    pool: &AnyPool,
    node: &NodeRef,
) -> Result<Vec<String>, String> {
    let table = node.name.clone().unwrap_or_default();
    if cfg.kind != "postgres" {
        return Ok(Vec::new());
    }
    let schema = node.schema.as_deref().unwrap_or("public");
    let sql = format!(
        "select a.attname::text from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey) where i.indisprimary and n.nspname = {} and c.relname = {}",
        lit(schema),
        lit(&table)
    );
    let rows = sqlx::query(&sql)
        .fetch_all(pool)
        .await
        .map_err(|e| friendly_error(&e.to_string()))?;
    let mut out = Vec::new();
    for r in rows {
        if let Some(v) = any_text(&r, 0) {
            out.push(v);
        }
    }
    Ok(out)
}

fn cell(row: &AnyRow, i: usize) -> CellValue {
    match row.try_get_raw(i) {
        Ok(raw) if ValueRef::is_null(&raw) => return CellValue::Null,
        Err(_) => return CellValue::Null,
        _ => {}
    }
    if let Ok(v) = row.try_get::<String, _>(i) {
        return CellValue::Text(v);
    }
    if let Ok(v) = row.try_get::<i64, _>(i) {
        return CellValue::Int(v);
    }
    if let Ok(v) = row.try_get::<f64, _>(i) {
        return CellValue::Float(v);
    }
    if let Ok(v) = row.try_get::<bool, _>(i) {
        return CellValue::Bool(v);
    }
    if let Ok(v) = row.try_get::<Vec<u8>, _>(i) {
        return CellValue::Binary(v.len());
    }
    CellValue::Null
}

fn numeric_type(kind: &str, type_name: &str) -> bool {
    let t = type_name.to_lowercase();
    match kind {
        "postgres" => matches!(
            t.as_str(),
            "smallint" | "integer" | "bigint" | "real" | "double precision" | "boolean" | "int2" | "int4" | "int8" | "float4" | "float8" | "bool"
        ),
        "mysql" => t.contains("int") || t.contains("float") || t.contains("double") || t.contains("year"),
        _ => t.contains("int") || t.contains("real") || t.contains("float") || t.contains("double"),
    }
}

/// 取列名与类型：用来决定哪些列需要转成文本，避免 Any 驱动遇到复杂类型解码失败
async fn table_column_types(
    cfg: &ConnectionConfig,
    pool: &AnyPool,
    node: &NodeRef,
    table: &str,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let sql = match cfg.kind.as_str() {
        "sqlite" => format!("select name, type from pragma_table_info({})", lit(table)),
        "postgres" => format!(
            "select column_name::text, data_type::text from information_schema.columns where table_schema={} and table_name={} order by ordinal_position",
            lit(node.schema.as_deref().unwrap_or("public")),
            lit(table)
        ),
        _ => format!(
            "select column_name, column_type from information_schema.columns where table_schema={} and table_name={} order by ordinal_position",
            lit(node.database.as_deref().unwrap_or_default()),
            lit(table)
        ),
    };
    if let Ok(rows) = sqlx::query(&sql).fetch_all(pool).await {
        for r in rows {
            let name: String = r.try_get(0).unwrap_or_default();
            let ty: String = r.try_get(1).unwrap_or_default();
            if !name.is_empty() {
                out.push((name, ty));
            }
        }
    }
    out
}

fn text_expr(kind: &str, id: &str) -> String {
    match kind {
        "postgres" => format!("{id}::text"),
        "mysql" => format!("cast({id} as char)"),
        _ => format!("cast({id} as text)"),
    }
}

fn like_op(kind: &str) -> &'static str {
    if kind == "postgres" {
        "ilike"
    } else {
        "like"
    }
}

/// 分页取表数据：排序 / 筛选 / 总数都在这里完成。
/// 返回的列名与列值已按「数值列原样、其余列转文本」处理，前端只负责渲染。
pub async fn rows(
    cfg: &ConnectionConfig,
    pool: &AnyPool,
    node: &NodeRef,
    limit: u32,
    offset: u32,
    sort: Option<&str>,
    desc: bool,
    filter: Option<&str>,
) -> Result<ResultSet, String> {
    let table = node.name.clone().unwrap_or_default();
    if table.is_empty() {
        return Err("未指定表名".to_string());
    }
    let qualified = match cfg.kind.as_str() {
        "mysql" => format!(
            "{}.{}",
            ident("mysql", node.database.as_deref().unwrap_or_default()),
            ident("mysql", &table)
        ),
        "postgres" => format!(
            "{}.{}",
            ident("postgres", node.schema.as_deref().unwrap_or("public")),
            ident("postgres", &table)
        ),
        _ => ident("sqlite", &table),
    };

    // 数值列直接取，其余列统一转文本：既避免 Any 驱动解码失败，也保证大整数/时间不丢精度
    let meta = table_column_types(cfg, pool, node, &table).await;
    let select_list = if meta.is_empty() {
        "*".to_string()
    } else {
        meta.iter()
            .map(|(name, ty)| {
                let id = ident(&cfg.kind, name);
                if numeric_type(&cfg.kind, ty) {
                    id.clone()
                } else {
                    // 转文本后要保留原列名，否则驱动会把表达式文本当成列名
                    let cast = if cfg.kind == "postgres" {
                        format!("{id}::text")
                    } else if cfg.kind == "mysql" {
                        format!("cast({id} as char)")
                    } else {
                        format!("cast({id} as text)")
                    };
                    format!("{cast} as {id}")
                }
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    // 排序：列名必须存在于表结构里，避免把任意字符串拼进 SQL
    let order = sort
        .filter(|c| meta.iter().any(|(n, _)| n == c))
        .map(|c| format!(" order by {} {}", ident(&cfg.kind, c), if desc { "desc" } else { "asc" }))
        .unwrap_or_default();

    // 快速筛选：对所有列做 LIKE（PG 用 ILIKE），值走绑定参数
    let keyword = filter.map(|f| f.trim().to_string()).filter(|f| !f.is_empty());
    let mut where_parts: Vec<String> = Vec::new();
    if keyword.is_some() && !meta.is_empty() {
        let op = like_op(&cfg.kind);
        for (i, (name, _)) in meta.iter().enumerate() {
            let id = ident(&cfg.kind, name);
            let expr = text_expr(&cfg.kind, &id);
            let ph = if cfg.kind == "postgres" {
                format!("${}", i + 1)
            } else {
                "?".to_string()
            };
            where_parts.push(format!("{expr} {op} {ph}"));
        }
    }
    let where_sql = if where_parts.is_empty() {
        String::new()
    } else {
        format!(" where ({})", where_parts.join(" or "))
    };

    let sql = format!("select {select_list} from {qualified}{where_sql}{order} limit {limit} offset {offset}");

    let start = Instant::now();
    let mut q = sqlx::query(&sql);
    if let Some(kw) = keyword.as_deref() {
        let pattern = format!("%{kw}%");
        for _ in 0..where_parts.len() {
            q = q.bind(pattern.clone());
        }
    }
    let data = q.fetch_all(pool).await.map_err(|e| friendly_error(&e.to_string()))?;
    let elapsed = start.elapsed().as_millis();

    let mut columns: Vec<String> = data
        .first()
        .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
        .unwrap_or_default();
    if columns.is_empty() {
        columns = meta.iter().map(|(n, _)| n.clone()).collect();
    }

    let rows = data
        .iter()
        .map(|r| (0..r.len()).map(|i| cell(r, i)).collect())
        .collect();

    // 总数：用于状态栏显示「共 N 行」，失败时不阻塞数据展示
    let total = count_rows(cfg, pool, &qualified, &where_parts, keyword.as_deref()).await;

    Ok(ResultSet {
        columns,
        rows,
        elapsed_ms: elapsed,
        fetched_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        total,
    })
}

async fn count_rows(
    cfg: &ConnectionConfig,
    pool: &AnyPool,
    qualified: &str,
    where_parts: &[String],
    keyword: Option<&str>,
) -> Option<u32> {
    let where_sql = if where_parts.is_empty() {
        String::new()
    } else {
        format!(" where ({})", where_parts.join(" or "))
    };
    let sql = format!("select count(*) from {qualified}{where_sql}");
    let mut q = sqlx::query(&sql);
    if let Some(kw) = keyword {
        let pattern = format!("%{kw}%");
        for _ in 0..where_parts.len() {
            q = q.bind(pattern.clone());
        }
    }
    let row = q.fetch_one(pool).await.ok()?;
    let n: i64 = row
        .try_get::<i64, _>(0)
        .ok()
        .or_else(|| row.try_get::<i32, _>(0).ok().map(|v| v as i64))
        .or_else(|| row.try_get::<String, _>(0).ok().and_then(|v| v.parse().ok()))
        .unwrap_or(0);
    let _ = cfg;
    Some(n.max(0) as u32)
}

/// 按顶层分号切分多语句。
///
/// 字符级状态机，跳过 `--` 行注释、`/* */` 块注释、单 / 双引号与反引号字符串
/// （含 `''` 与反斜杠转义）、PG 的 `$$` / `$tag$` dollar quote。
/// 只有这些结构之外的分号才算语句分隔符。
pub fn split_statements(sql: &str) -> Vec<String> {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        // 行注释
        if c == '-' && next == Some('-') {
            while i < chars.len() && chars[i] != '\n' {
                buf.push(chars[i]);
                i += 1;
            }
            continue;
        }
        // 块注释
        if c == '/' && next == Some('*') {
            buf.push(c);
            buf.push('*');
            i += 2;
            while i < chars.len() {
                if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    buf.push('*');
                    buf.push('/');
                    i += 2;
                    break;
                }
                buf.push(chars[i]);
                i += 1;
            }
            continue;
        }
        // 单/双引号与反引号
        if c == '\'' || c == '"' || c == '`' {
            let q = c;
            buf.push(c);
            i += 1;
            while i < chars.len() {
                let d = chars[i];
                buf.push(d);
                if q != '`' && d == '\\' && i + 1 < chars.len() {
                    buf.push(chars[i + 1]);
                    i += 2;
                    continue;
                }
                if d == q {
                    if q != '`' && chars.get(i + 1) == Some(&q) {
                        buf.push(q);
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        // PostgreSQL 的 $$ / $tag$ dollar quote
        if c == '$' {
            let mut j = i + 1;
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            if j < chars.len() && chars[j] == '$' {
                let tag: String = chars[i..=j].iter().collect();
                buf.push_str(&tag);
                i = j + 1;
                while i < chars.len() {
                    if chars[i..].starts_with(&tag.chars().collect::<Vec<_>>()[..]) {
                        buf.push_str(&tag);
                        i += tag.chars().count();
                        break;
                    }
                    buf.push(chars[i]);
                    i += 1;
                }
                continue;
            }
        }
        if c == ';' {
            let stmt = buf.trim().trim_end_matches(';').trim().to_string();
            if !stmt.is_empty() {
                out.push(stmt);
            }
            buf.clear();
            i += 1;
            continue;
        }
        buf.push(c);
        i += 1;
    }
    let stmt = buf.trim().trim_end_matches(';').trim().to_string();
    if !stmt.is_empty() {
        out.push(stmt);
    }
    out
}

/// 判断语句是否只读。宁可放宽（EXPLAIN / PRAGMA 也算查询），
/// 也不要把明显的写语句漏进只读连接。
fn is_query_stmt(stmt: &str) -> bool {
    let first = stmt.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
    matches!(
        first.as_str(),
        "select" | "with" | "show" | "describe" | "desc" | "explain" | "pragma" | "values"
    )
}

/// 在给定连接上顺序执行（调用方负责事务与取消登记）
/// 在一个连接（通常已包在事务里）上顺序执行多条语句。
///
/// 只读校验放在执行之前：先整体检查，再逐条执行，避免执行到一半才被拒绝。
/// 多语句只回最后一条的结果集，另外用 `notice` 汇总「共执行 N 条 / 影响 M 行」。
pub async fn execute_on(
    conn: &mut sqlx::AnyConnection,
    sql: &str,
    allow_write: bool,
) -> Result<SqlResult, String> {
    let stmts = split_statements(sql);
    if stmts.is_empty() {
        return Err("请输入要执行的 SQL".to_string());
    }

    let start = Instant::now();
    let fetched_at = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

    // 只读检查放在执行前，避免执行到一半才拒绝
    if !allow_write {
        for st in &stmts {
            if !is_query_stmt(st) {
                return Err("当前连接标记为「只读」，已阻止写操作".to_string());
            }
        }
    }

    let mut total_affected: u64 = 0;
    let mut last: Option<SqlResult> = None;
    for (idx, st) in stmts.iter().enumerate() {
        let query_stmt = is_query_stmt(st);
        let res = if query_stmt {
            let data = sqlx::query(st)
                .fetch_all(&mut *conn)
                .await
                .map_err(|e| {
                    format!(
                        "第 {} 条语句执行失败：{}",
                        idx + 1,
                        friendly_error(&e.to_string())
                    )
                })?;
            let columns: Vec<String> = data
                .first()
                .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let rows = data
                .iter()
                .map(|r| (0..r.len()).map(|i| cell(r, i)).collect())
                .collect();
            SqlResult {
                columns,
                rows,
                elapsed_ms: 0,
                fetched_at: fetched_at.clone(),
                affected: None,
                is_query: true,
                executed: 1,
                notice: None,
            }
        } else {
            let r = sqlx::query(st)
                .execute(&mut *conn)
                .await
                .map_err(|e| {
                    format!(
                        "第 {} 条语句执行失败：{}",
                        idx + 1,
                        friendly_error(&e.to_string())
                    )
                })?;
            total_affected += r.rows_affected();
            SqlResult {
                columns: Vec::new(),
                rows: Vec::new(),
                elapsed_ms: 0,
                fetched_at: fetched_at.clone(),
                affected: Some(r.rows_affected()),
                is_query: false,
                executed: 1,
                notice: None,
            }
        };
        last = Some(res);
    }

    let mut result = last.unwrap_or(SqlResult {
        columns: Vec::new(),
        rows: Vec::new(),
        elapsed_ms: 0,
        fetched_at,
        affected: None,
        is_query: true,
        executed: 0,
        notice: None,
    });
    result.elapsed_ms = start.elapsed().as_millis();
    result.executed = stmts.len() as u32;
    if stmts.len() > 1 {
        let rows = if result.is_query {
            format!("最后一条返回 {} 行", result.rows.len())
        } else {
            format!("累计影响 {total_affected} 行")
        };
        result.notice = Some(format!("共执行 {} 条语句，{rows}", stmts.len()));
        if !result.is_query {
            result.affected = Some(total_affected);
        }
    }
    Ok(result)
}


pub async fn indexes(
    cfg: &ConnectionConfig,
    pool: &AnyPool,
    node: &NodeRef,
) -> Result<Vec<IndexMeta>, String> {
    let table = node.name.clone().unwrap_or_default();
    let mut out: Vec<IndexMeta> = Vec::new();

    match cfg.kind.as_str() {
        "sqlite" => {
            let list = sqlx::query(&format!("pragma index_list({})", lit(&table)))
                .fetch_all(pool)
                .await
                .map_err(|e| friendly_error(&e.to_string()))?;
            for r in list {
                let name: String = r.try_get("name").unwrap_or_default();
                let unique: i64 = r.try_get("unique").unwrap_or(0);
                let origin: String = r.try_get("origin").unwrap_or_default();
                let mut cols = Vec::new();
                if let Ok(info) =
                    sqlx::query(&format!("pragma index_info({})", lit(&name))).fetch_all(pool).await
                {
                    for c in info {
                        if let Ok(n) = c.try_get::<String, _>("name") {
                            if !n.is_empty() {
                                cols.push(n);
                            }
                        }
                    }
                }
                out.push(IndexMeta {
                    name,
                    columns: cols,
                    unique: unique != 0,
                    primary: origin == "pk",
                    method: None,
                });
            }
            // SQLite 的 `id integer primary key` 是 rowid 别名，pragma index_list 看不到，
            // 这里补一条合成的主键条目，保证界面上的 PK 信息完整。
            if !out.iter().any(|i| i.primary) {
                if let Ok(info) =
                    sqlx::query(&format!("pragma table_info({})", lit(&table))).fetch_all(pool).await
                {
                    let mut pk_cols: Vec<(i64, String)> = Vec::new();
                    for c in info {
                        let pk: i64 = c.try_get("pk").unwrap_or(0);
                        if pk > 0 {
                            let name: String = c.try_get("name").unwrap_or_default();
                            pk_cols.push((pk, name));
                        }
                    }
                    if !pk_cols.is_empty() {
                        pk_cols.sort_by_key(|(ord, _)| *ord);
                        out.push(IndexMeta {
                            name: "PRIMARY".into(),
                            columns: pk_cols.into_iter().map(|(_, n)| n).collect(),
                            unique: true,
                            primary: true,
                            method: None,
                        });
                    }
                }
            }
        }
        "postgres" => {
            let sql = format!(
                r#"select i.relname::text as idx, ix.indisunique, ix.indisprimary, a.attname::text as col,
                        row_number() over (partition by i.relname order by a.attnum) as ord
                   from pg_class t
                   join pg_index ix on ix.indrelid = t.oid
                   join pg_class i on i.oid = ix.indexrelid
                   join pg_attribute a on a.attrelid = t.oid and a.attnum = any(ix.indkey)
                  where t.relname = {tbl} and t.relnamespace = {schema}::regnamespace
                  order by idx, ord"#,
                tbl = lit(&table),
                schema = lit(node.schema.as_deref().unwrap_or("public"))
            );
            let rows = sqlx::query(&sql)
                .fetch_all(pool)
                .await
                .map_err(|e| friendly_error(&e.to_string()))?;
            for r in rows {
                let name: String = r.try_get(0).unwrap_or_default();
                let unique: bool = r.try_get(1).unwrap_or(false);
                let primary: bool = r.try_get(2).unwrap_or(false);
                let col: String = r.try_get(3).unwrap_or_default();
                match out.iter_mut().find(|i| i.name == name) {
                    Some(slot) => slot.columns.push(col),
                    None => out.push(IndexMeta {
                        name,
                        columns: vec![col],
                        unique,
                        primary,
                        method: None,
                    }),
                }
            }
        }
        _ => {
            let sql = format!(
                "select index_name, non_unique, column_name, index_type from information_schema.statistics where table_schema={} and table_name={} order by index_name, seq_in_index",
                lit(node.database.as_deref().unwrap_or_default()),
                lit(&table)
            );
            let rows = sqlx::query(&sql)
                .fetch_all(pool)
                .await
                .map_err(|e| friendly_error(&e.to_string()))?;
            for r in rows {
                let name: String = r.try_get(0).unwrap_or_default();
                let non_unique: i64 = r.try_get(1).unwrap_or(1);
                let col: String = r.try_get(2).unwrap_or_default();
                let method: String = r.try_get(3).unwrap_or_default();
                match out.iter_mut().find(|i| i.name == name) {
                    Some(slot) => slot.columns.push(col),
                    None => out.push(IndexMeta {
                        name: name.clone(),
                        columns: vec![col],
                        unique: non_unique == 0,
                        primary: name == "PRIMARY",
                        method: if method.is_empty() { None } else { Some(method) },
                    }),
                }
            }
        }
    }
    Ok(out)
}

pub async fn foreign_keys(
    cfg: &ConnectionConfig,
    pool: &AnyPool,
    node: &NodeRef,
) -> Result<Vec<ForeignKeyMeta>, String> {
    let table = node.name.clone().unwrap_or_default();
    let mut out: Vec<ForeignKeyMeta> = Vec::new();

    match cfg.kind.as_str() {
        "sqlite" => {
            let rows = sqlx::query(&format!("pragma foreign_key_list({})", lit(&table)))
                .fetch_all(pool)
                .await
                .map_err(|e| friendly_error(&e.to_string()))?;
            for r in rows {
                let id: i64 = r.try_get("id").unwrap_or(0);
                let name = format!("fk_{id}");
                let ref_table: String = r.try_get("table").unwrap_or_default();
                let from: String = r.try_get("from").unwrap_or_default();
                let to: String = r.try_get("to").unwrap_or_default();
                let on_update: String = r.try_get("on_update").unwrap_or_default();
                let on_delete: String = r.try_get("on_delete").unwrap_or_default();
                match out.iter_mut().find(|f| f.name == name) {
                    Some(slot) => {
                        slot.columns.push(from);
                        slot.ref_columns.push(to);
                    }
                    None => out.push(ForeignKeyMeta {
                        name,
                        columns: vec![from],
                        ref_table,
                        ref_columns: vec![to],
                        on_delete: Some(on_delete),
                        on_update: Some(on_update),
                    }),
                }
            }
        }
        "postgres" => {
            let sql = format!(
                r#"select con.conname::text as name, ka.attname::text as col, fa.attname::text as ref_col,
                        cl.relname::text as ref_table,
                        case con.confdeltype when 'c' then 'CASCADE' when 'a' then 'NO ACTION'
                             when 'r' then 'RESTRICT' when 'd' then 'SET NULL' when 'n' then 'SET DEFAULT' end as on_delete
                   from pg_constraint con
                   join pg_class c on c.oid = con.conrelid
                   join pg_class cl on cl.oid = con.confrelid
                   join lateral unnest(con.conkey, con.confkey) with ordinality as k(attnum, fattnum, ord) on true
                   join pg_attribute ka on ka.attrelid = con.conrelid and ka.attnum = k.attnum
                   join pg_attribute fa on fa.attrelid = con.confrelid and fa.attnum = k.fattnum
                  where con.contype = 'f' and c.relname = {tbl} and c.relnamespace = {schema}::regnamespace
                  order by name, k.ord"#,
                tbl = lit(&table),
                schema = lit(node.schema.as_deref().unwrap_or("public"))
            );
            let rows = sqlx::query(&sql)
                .fetch_all(pool)
                .await
                .map_err(|e| friendly_error(&e.to_string()))?;
            for r in rows {
                let name: String = r.try_get(0).unwrap_or_default();
                let col: String = r.try_get(1).unwrap_or_default();
                let ref_col: String = r.try_get(2).unwrap_or_default();
                let ref_table: String = r.try_get(3).unwrap_or_default();
                let on_delete: Option<String> = r.try_get(4).ok();
                match out.iter_mut().find(|f| f.name == name) {
                    Some(slot) => {
                        slot.columns.push(col);
                        slot.ref_columns.push(ref_col);
                    }
                    None => out.push(ForeignKeyMeta {
                        name,
                        columns: vec![col],
                        ref_table,
                        ref_columns: vec![ref_col],
                        on_delete,
                        on_update: None,
                    }),
                }
            }
        }
        _ => {
            let sql = format!(
                r#"select k.constraint_name, k.column_name, k.referenced_table_name, k.referenced_column_name,
                          r.delete_rule, r.update_rule
                     from information_schema.key_column_usage k
                     left join information_schema.referential_constraints r
                       on r.constraint_name = k.constraint_name and r.constraint_schema = k.constraint_schema
                    where k.table_schema = {db} and k.table_name = {tbl} and k.referenced_table_name is not null
                    order by k.constraint_name, k.ordinal_position"#,
                db = lit(node.database.as_deref().unwrap_or_default()),
                tbl = lit(&table)
            );
            let rows = sqlx::query(&sql)
                .fetch_all(pool)
                .await
                .map_err(|e| friendly_error(&e.to_string()))?;
            for r in rows {
                let name: String = r.try_get(0).unwrap_or_default();
                let col: String = r.try_get(1).unwrap_or_default();
                let ref_table: String = r.try_get(2).unwrap_or_default();
                let ref_col: String = r.try_get(3).unwrap_or_default();
                let on_delete: Option<String> = r.try_get(4).ok();
                let on_update: Option<String> = r.try_get(5).ok();
                match out.iter_mut().find(|f| f.name == name) {
                    Some(slot) => {
                        slot.columns.push(col);
                        slot.ref_columns.push(ref_col);
                    }
                    None => out.push(ForeignKeyMeta {
                        name,
                        columns: vec![col],
                        ref_table,
                        ref_columns: vec![ref_col],
                        on_delete,
                        on_update,
                    }),
                }
            }
        }
    }
    Ok(out)
}

pub async fn ddl(
    cfg: &ConnectionConfig,
    pool: &AnyPool,
    node: &NodeRef,
) -> Result<DdlResult, String> {
    let table = node.name.clone().unwrap_or_default();

    match cfg.kind.as_str() {
        "mysql" => {
            let qualified = format!(
                "{}.{}",
                ident("mysql", node.database.as_deref().unwrap_or_default()),
                ident("mysql", &table)
            );
            let row = sqlx::query(&format!("show create table {qualified}"))
                .fetch_one(pool)
                .await
                .map_err(|e| friendly_error(&e.to_string()))?;
            let sql: String = row.try_get(1).unwrap_or_default();
            Ok(DdlResult { sql, generated: false })
        }
        "sqlite" => {
            let sql = sqlx::query(&format!(
                "select sql from sqlite_master where type in ('table','view') and name={}",
                lit(&table)
            ))
            .fetch_all(pool)
            .await
            .map_err(|e| friendly_error(&e.to_string()))?;
            let text = sql
                .first()
                .and_then(|r| r.try_get::<Option<String>, _>(0).ok().flatten())
                .unwrap_or_else(|| format!("-- 未取到 {} 的建表语句", table));
            Ok(DdlResult { sql: text, generated: false })
        }
        _ => {
            // PostgreSQL 没有 SHOW CREATE TABLE，这里按字段元数据拼装，并显式标记 generated
            let cols = columns(cfg, pool, node).await?;
            let idx = indexes(cfg, pool, node).await.unwrap_or_default();
            let mut lines: Vec<String> = cols
                .iter()
                .map(|c| {
                    let mut line = format!("  {} {}", ident("postgres", &c.name), c.type_name);
                    if !c.nullable {
                        line.push_str(" NOT NULL");
                    }
                    if let Some(d) = c.default_value.as_deref() {
                        line.push_str(&format!(" DEFAULT {d}"));
                    }
                    line
                })
                .collect();
            if let Some(pk) = idx.iter().find(|i| i.primary) {
                lines.push(format!(
                    "  PRIMARY KEY ({})",
                    pk.columns
                        .iter()
                        .map(|c| ident("postgres", c))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            let qualified = format!(
                "{}.{}",
                ident("postgres", node.schema.as_deref().unwrap_or("public")),
                ident("postgres", &table)
            );
            Ok(DdlResult {
                sql: format!("CREATE TABLE {qualified} (\n{}\n);", lines.join(",\n")),
                generated: true,
            })
        }
    }
}

/// 把界面输入的字符串转成 SQL 字面量：
/// - 空值写 `NULL`（界面上「留空」表示 NULL，不是空字符串）
/// - 数值列且能解析成数字时写裸值，避免 `integer = '1.2e3'` 这类隐式转换
/// - 其余一律单引号包裹并双写单引号
fn quote_literal(cfg: &ConnectionConfig, ty: &str, value: Option<&str>) -> String {
    match value {
        None => "NULL".to_string(),
        Some(v) => {
            // 数值列且能解析成数字时直接写裸字面量，避免 `integer = '1.2e3'` 这类隐式转换问题
            if numeric_type(&cfg.kind, ty) && v.trim().parse::<f64>().is_ok() {
                v.trim().to_string()
            } else {
                format!("'{}'", v.replace('\'', "''"))
            }
        }
    }
}

/// 生成单行 UPDATE。调用前会校验主键列确实属于这张表，
/// WHERE 两侧都转文本比较，避免类型不一致导致「一行没更新」或误伤。
pub async fn update_sql(
    cfg: &ConnectionConfig,
    pool: &AnyPool,
    node: &NodeRef,
    keys: &[KeyValue],
    column: &str,
    value: Option<&str>,
) -> Result<String, String> {
    let table = node.name.clone().unwrap_or_default();
    if table.is_empty() || keys.is_empty() {
        return Err("缺少表名或主键条件，无法生成 UPDATE".to_string());
    }
    let meta = table_column_types(cfg, pool, node, &table).await;
    let target = meta
        .iter()
        .find(|(n, _)| n == column)
        .ok_or_else(|| format!("字段 {column} 不属于这张表"))?;
    for k in keys {
        if !meta.iter().any(|(n, _)| n == &k.column) {
            return Err(format!("主键字段 {} 不属于这张表", k.column));
        }
    }

    let qualified = match cfg.kind.as_str() {
        "mysql" => format!(
            "{}.{}",
            ident("mysql", node.database.as_deref().unwrap_or_default()),
            ident("mysql", &table)
        ),
        "postgres" => format!(
            "{}.{}",
            ident("postgres", node.schema.as_deref().unwrap_or("public")),
            ident("postgres", &table)
        ),
        _ => ident("sqlite", &table),
    };

    let set = format!(
        "{} = {}",
        ident(&cfg.kind, column),
        quote_literal(cfg, &target.1, value)
    );
    let mut where_parts = Vec::new();
    for k in keys {
        let id = ident(&cfg.kind, &k.column);
        let expr = text_expr(&cfg.kind, &id);
        where_parts.push(format!(
            "{expr} = '{}'",
            k.value.replace('\'', "''")
        ));
    }

    Ok(format!(
        "UPDATE {qualified} SET {set} WHERE {}",
        where_parts.join(" AND ")
    ))
}

fn qualified_table(cfg: &ConnectionConfig, node: &NodeRef, table: &str) -> String {
    match cfg.kind.as_str() {
        "mysql" => format!(
            "{}.{}",
            ident("mysql", node.database.as_deref().unwrap_or_default()),
            ident("mysql", table)
        ),
        "postgres" => format!(
            "{}.{}",
            ident("postgres", node.schema.as_deref().unwrap_or("public")),
            ident("postgres", table)
        ),
        _ => ident("sqlite", table),
    }
}

/// 生成 INSERT：values 只包含用户填了值的列，空列交给数据库默认值
/// 生成 INSERT：只把用户填了值的列拼进语句，其余列交给数据库默认值 / 自增。
/// 一列都没填时，MySQL 用 `insert into t () values ()`，其余用 `default values`。
pub async fn insert_sql(
    cfg: &ConnectionConfig,
    pool: &AnyPool,
    node: &NodeRef,
    values: &[KeyValue],
) -> Result<String, String> {
    let table = node.name.clone().unwrap_or_default();
    if table.is_empty() {
        return Err("缺少表名，无法生成 INSERT".to_string());
    }
    let meta = table_column_types(cfg, pool, node, &table).await;
    let qualified = qualified_table(cfg, node, &table);

    if values.is_empty() {
        let sql = if cfg.kind == "mysql" {
            format!("insert into {qualified} () values ()")
        } else {
            format!("insert into {qualified} default values")
        };
        return Ok(sql);
    }

    let mut cols = Vec::new();
    let mut lits = Vec::new();
    for kv in values {
        let ty = meta
            .iter()
            .find(|(n, _)| n == &kv.column)
            .map(|(_, t)| t.clone())
            .ok_or_else(|| format!("字段 {} 不属于这张表", kv.column))?;
        cols.push(ident(&cfg.kind, &kv.column));
        lits.push(quote_literal(cfg, &ty, Some(&kv.value)));
    }
    Ok(format!(
        "insert into {qualified} ({}) values ({})",
        cols.join(", "),
        lits.join(", ")
    ))
}

/// 生成 DELETE，条件与 UPDATE 一致：主键按文本比较
/// 多行删除：每行一组主键条件，行与行之间用 OR 连接（同一事务内一次执行）
/// 整库表结构（用于 SQL 自动补全）：一次查询拿 schema 内所有表与字段
/// 整库表结构（表名 + 字段名），供 SQL 编辑器补全使用。
/// 一次查询拿全 schema，避免写 join 时只认识当前打开的那张表。
pub async fn schema_map(cfg: &ConnectionConfig, pool: &AnyPool, node: &NodeRef) -> Result<Vec<crate::model::SchemaTable>, String> {
    let mut out: Vec<crate::model::SchemaTable> = Vec::new();
    let rows = match cfg.kind.as_str() {
        "mysql" => {
            sqlx::query(
                "select table_name, column_name from information_schema.columns \
                 where table_schema = database() order by table_name, ordinal_position",
            )
            .fetch_all(pool)
            .await
        }
        "postgres" => {
            let schema = node.schema.clone().unwrap_or_else(|| "public".to_string());
            sqlx::query(
                "select table_name, column_name from information_schema.columns \
                 where table_schema = $1 order by table_name, ordinal_position",
            )
            .bind(schema)
            .fetch_all(pool)
            .await
        }
        _ => {
            sqlx::query(
                "select name as table_name, null as column_name from sqlite_master \
                 where type = 'table' and name not like 'sqlite_%'",
            )
            .fetch_all(pool)
            .await
        }
    }
    .map_err(|e| friendly_error(&e.to_string()))?;

    for row in rows {
        let table = any_text(&row, 0).unwrap_or_default();
        if table.is_empty() {
            continue;
        }
        let column = any_text(&row, 1);
        match out.iter_mut().find(|t| t.name == table) {
            Some(t) => {
                if let Some(c) = column {
                    t.columns.push(c);
                }
            }
            None => out.push(crate::model::SchemaTable {
                name: table,
                columns: column.into_iter().collect(),
            }),
        }
    }
    // SQLite 的 pragma 需要逐表取字段
    if cfg.kind == "sqlite" {
        for t in out.iter_mut() {
            let sql = format!("select name from pragma_table_info('{}')", t.name.replace('\'', "''"));
            if let Ok(rs) = sqlx::query(&sql).fetch_all(pool).await {
                t.columns = rs.iter().filter_map(|r| any_text(r, 0)).collect();
            }
        }
    }
    Ok(out)
}

/// 把要删除的行先拍成 INSERT 语句，用于「撤销删除」
/// 把即将删除的行拍成 INSERT 语句（撤销删除用）。
/// 先按主键 select 出整行并统一 CAST 成文本，再拼字面量；NULL 保持 NULL。
pub async fn snapshot_inserts(
    cfg: &ConnectionConfig,
    pool: &AnyPool,
    node: &NodeRef,
    rows: &[Vec<KeyValue>],
) -> Result<Vec<String>, String> {
    let table = node.name.clone().unwrap_or_default();
    if table.is_empty() || rows.is_empty() {
        return Ok(Vec::new());
    }
    let qualified = qualified_table(cfg, node, &table);
    let meta = table_column_types(cfg, pool, node, &table).await;
    let columns: Vec<String> = if meta.is_empty() {
        return Ok(Vec::new());
    } else {
        meta.iter().map(|(n, _)| n.clone()).collect()
    };
    let select_list = columns
        .iter()
        .map(|c| {
            let id = ident(&cfg.kind, c);
            let cast = if cfg.kind == "postgres" {
                format!("{id}::text")
            } else if cfg.kind == "mysql" {
                format!("cast({id} as char)")
            } else {
                format!("cast({id} as text)")
            };
            format!("{cast} as {id}")
        })
        .collect::<Vec<_>>()
        .join(", ");
    let groups: Vec<String> = rows
        .iter()
        .map(|row| {
            let conds: Vec<String> = row
                .iter()
                .map(|k| {
                    let id = ident(&cfg.kind, &k.column);
                    format!(
                        "{} = {}",
                        text_expr(&cfg.kind, &id),
                        quote_literal(cfg, "text", Some(&k.value))
                    )
                })
                .collect();
            if conds.len() > 1 { format!("({})", conds.join(" and ")) } else { conds.join(" and ") }
        })
        .collect();
    let sql = format!("select {select_list} from {qualified} where {}", groups.join(" or "));
    let fetched = sqlx::query(&sql)
        .fetch_all(pool)
        .await
        .map_err(|e| friendly_error(&e.to_string()))?;

    let mut inserts = Vec::new();
    for row in fetched {
        let vals: Vec<String> = (0..columns.len())
            .map(|i| match any_text(&row, i) {
                Some(v) => quote_literal(cfg, "text", Some(&v)),
                None => "NULL".to_string(),
            })
            .collect();
        let cols: Vec<String> = columns.iter().map(|c| ident(&cfg.kind, c)).collect();
        inserts.push(format!(
            "insert into {qualified} ({}) values ({})",
            cols.join(", "),
            vals.join(", ")
        ));
    }
    Ok(inserts)
}

/// 生成多行 DELETE：每行一组主键条件，行之间 OR；多列主键每组加括号。
/// 只支持单条 DELETE，避免 N 行删成 N 条语句。
pub async fn delete_many_sql(
    cfg: &ConnectionConfig,
    pool: &AnyPool,
    node: &NodeRef,
    rows: &[Vec<KeyValue>],
) -> Result<String, String> {
    let table = node.name.clone().unwrap_or_default();
    if table.is_empty() || rows.is_empty() {
        return Err("缺少表名或主键条件，无法生成 DELETE".to_string());
    }
    let meta = table_column_types(cfg, pool, node, &table).await;
    let first_cols: Vec<String> = rows[0].iter().map(|k| k.column.clone()).collect();
    for row in rows {
        if row.is_empty() {
            return Err("存在没有主键值的行，无法生成 DELETE".to_string());
        }
        let cols: Vec<String> = row.iter().map(|k| k.column.clone()).collect();
        if cols != first_cols {
            return Err("多行删除的主键列不一致".to_string());
        }
        for k in row {
            if !meta.iter().any(|(n, _)| n == &k.column) {
                return Err(format!("主键字段 {} 不属于这张表", k.column));
            }
        }
    }
    let qualified = qualified_table(cfg, node, &table);
    let groups: Vec<String> = rows
        .iter()
        .map(|row| {
            let conds: Vec<String> = row
                .iter()
                .map(|k| {
                    let id = ident(&cfg.kind, &k.column);
                    format!(
                        "{} = {}",
                        text_expr(&cfg.kind, &id),
                        quote_literal(cfg, "text", Some(&k.value))
                    )
                })
                .collect();
            if conds.len() > 1 {
                format!("({})", conds.join(" and "))
            } else {
                conds.join(" and ")
            }
        })
        .collect();
    Ok(format!(
        "delete from {qualified} where {}",
        groups.join(" or ")
    ))
}

/// 生成单行 DELETE，条件与 UPDATE 一致（主键按文本比较）。
pub async fn delete_sql(
    cfg: &ConnectionConfig,
    pool: &AnyPool,
    node: &NodeRef,
    keys: &[KeyValue],
) -> Result<String, String> {
    let table = node.name.clone().unwrap_or_default();
    if table.is_empty() || keys.is_empty() {
        return Err("缺少表名或主键条件，无法生成 DELETE".to_string());
    }
    let meta = table_column_types(cfg, pool, node, &table).await;
    for k in keys {
        if !meta.iter().any(|(n, _)| n == &k.column) {
            return Err(format!("主键字段 {} 不属于这张表", k.column));
        }
    }
    let qualified = qualified_table(cfg, node, &table);
    let conds: Vec<String> = keys
        .iter()
        .map(|k| {
            let id = ident(&cfg.kind, &k.column);
            format!(
                "{} = {}",
                text_expr(&cfg.kind, &id),
                quote_literal(cfg, "text", Some(&k.value))
            )
        })
        .collect();
    Ok(format!(
        "delete from {qualified} where {}",
        conds.join(" and ")
    ))
}

/// 视图 / 函数 / 存储过程 / 触发器的定义
/// 视图 / 函数 / 存储过程 / 触发器的定义。
/// PG 走 `pg_get_*def`，MySQL 走 `show create ...`（取第 2 列，需要权限），
/// SQLite 直接查 `sqlite_master`。
pub async fn object_ddl(
    cfg: &ConnectionConfig,
    pool: &AnyPool,
    node: &NodeRef,
) -> Result<DdlResult, String> {
    let name = node.name.clone().unwrap_or_default();
    let schema = node.schema.clone().unwrap_or_else(|| "public".to_string());
    let database = node.database.clone().unwrap_or_default();
    let kind = node.kind.clone();
    let generated = false;

    let sql = match cfg.kind.as_str() {
        "postgres" => match kind.as_str() {
            "view" => {
                let r = sqlx::query(
                    "select pg_get_viewdef((quote_ident($1) || '.' || quote_ident($2))::regclass, true)",
                )
                .bind(&schema)
                .bind(&name)
                .fetch_one(pool)
                .await
                .map_err(|e| friendly_error(&e.to_string()))?;
                let body: String = r.try_get(0).unwrap_or_default();
                format!("create or replace view {}.{} as\n{}", ident("postgres", &schema), ident("postgres", &name), body)
            }
            "function" | "procedure" => {
                let q = "select pg_get_functiondef(p.oid) from pg_proc p \
                         join pg_namespace n on n.oid = p.pronamespace \
                         where n.nspname = $1 and p.proname = $2 limit 1";
                let r = sqlx::query(q)
                    .bind(&schema)
                    .bind(&name)
                    .fetch_one(pool)
                    .await
                    .map_err(|e| friendly_error(&e.to_string()))?;
                any_text(&r, 0).ok_or_else(|| "取不到函数定义".to_string())?
            }
            "trigger" => {
                let q = "select pg_get_triggerdef(t.oid) from pg_trigger t \
                         join pg_class c on c.oid = t.tgrelid \
                         join pg_namespace n on n.oid = c.relnamespace \
                         where n.nspname = $1 and t.tgname = $2 limit 1";
                let r = sqlx::query(q)
                    .bind(&schema)
                    .bind(&name)
                    .fetch_one(pool)
                    .await
                    .map_err(|e| friendly_error(&e.to_string()))?;
                any_text(&r, 0).ok_or_else(|| "取不到触发器定义".to_string())?
            }
            _ => return Err("该对象没有可查看的定义".to_string()),
        },
        "mysql" => {
            let full = format!(
                "{}.{}",
                ident("mysql", &database),
                ident("mysql", &name)
            );
            let stmt = match kind.as_str() {
                "view" => format!("show create view {full}"),
                "function" => format!("show create function {full}"),
                "procedure" => format!("show create procedure {full}"),
                "trigger" => format!("show create trigger {full}"),
                _ => return Err("该对象没有可查看的定义".to_string()),
            };
            let r = sqlx::query(&stmt)
                .fetch_one(pool)
                .await
                .map_err(|e| friendly_error(&e.to_string()))?;
            // SHOW CREATE 的第 2 列是定义
            any_text(&r, 1).ok_or_else(|| "取不到对象定义".to_string())?
            
        }
        _ => {
            let ty = match kind.as_str() {
                "view" => "view",
                "trigger" => "trigger",
                _ => {
                    return Err("SQLite 不保存函数/存储过程的定义".to_string());
                }
            };
            let r = sqlx::query("select sql from sqlite_master where type = $1 and name = $2")
                .bind(ty)
                .bind(&name)
                .fetch_optional(pool)
                .await
                .map_err(|e| friendly_error(&e.to_string()))?;
            r.and_then(|row| any_text(&row, 0))
                .ok_or_else(|| format!("找不到 {name} 的定义"))?
        }
    };

    Ok(DdlResult { sql, generated })
}

pub async fn update_apply(pool: &AnyPool, sql: &str) -> Result<u64, String> {
    let mut tx = pool.begin().await.map_err(|e| friendly_error(&e.to_string()))?;
    let res = sqlx::query(sql)
        .execute(&mut *tx)
        .await
        .map_err(|e| friendly_error(&e.to_string()))?;
    tx.commit().await.map_err(|e| friendly_error(&e.to_string()))?;
    Ok(res.rows_affected())
}

fn csv_field(c: &CellValue) -> String {
    let raw = match c {
        CellValue::Null => return String::new(),
        CellValue::Text(s) => s.clone(),
        CellValue::Int(i) => i.to_string(),
        CellValue::Float(f) => f.to_string(),
        CellValue::Bool(b) => b.to_string(),
        CellValue::Binary(n) => format!("{n} bytes"),
    };
    if raw.contains(',') || raw.contains('"') || raw.contains('\n') || raw.contains('\r') {
        format!("\"{}\"", raw.replace('"', "\"\""))
    } else {
        raw
    }
}

/// 导出 CSV：按当前显示的顺序取 10 万行上限，值按 RFC 4180 转义后落盘。
pub async fn export_csv(
    cfg: &ConnectionConfig,
    pool: &AnyPool,
    node: &NodeRef,
    limit: u32,
) -> Result<ExportResult, String> {
    let rs = rows(cfg, pool, node, limit, 0, None, false, None).await?;
    let table = node.name.clone().unwrap_or_else(|| "table".to_string());
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();

    let mut out = String::new();
    out.push_str(&rs.columns.join(","));
    out.push('\n');
    for row in &rs.rows {
        out.push_str(&row.iter().map(csv_field).collect::<Vec<_>>().join(","));
        out.push('\n');
    }

    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let dir = std::path::Path::new(&home).join("Downloads");
    let dir = if dir.is_dir() { dir } else { std::env::temp_dir() };
    let path = dir.join(format!("sqll-{}-{}.csv", table, stamp));
    std::fs::write(&path, out).map_err(|e| format!("写入 CSV 失败：{e}"))?;

    Ok(ExportResult {
        path: path.to_string_lossy().to_string(),
        rows: rs.rows.len() as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ConnectionConfig, NodeRef};

    fn sqlite_cfg(path: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: "t".into(),
            name: "t".into(),
            kind: "sqlite".into(),
            host: String::new(),
            port: 0,
            database: None,
            user: None,
            ssl_mode: "disabled".into(),
            ca_path: None,
            color: None,
            read_only: None,
            production: None,
            file_path: Some(path.to_string()),
            has_password: false,
        }
    }

    fn my_cfg() -> ConnectionConfig {
        ConnectionConfig {
            id: "m".into(),
            name: "m".into(),
            kind: "mysql".into(),
            host: "127.0.0.1".into(),
            port: 3307,
            database: Some("sqll_test".into()),
            user: Some("root".into()),
            ssl_mode: "disabled".into(),
            ca_path: None,
            color: None,
            read_only: None,
            production: None,
            file_path: None,
            has_password: false,
        }
    }

    #[test]
    fn mysql_probe() {
        if std::env::var("SQLL_TEST_MYSQL").is_err() {
            return;
        }
        rt().block_on(async {
            let cfg = my_cfg();
            let pool = connect(&cfg, None, None).await.unwrap();
            let v = server_version(&pool, "sqll_test").await.unwrap();
            println!("MySQL version: {v}");

            let dbs = children(&cfg, &pool, &nref("server", None, None, None, None)).await.unwrap();
            println!("databases: {:?}", dbs.iter().map(|d| &d.label).collect::<Vec<_>>());
            assert!(dbs.iter().any(|d| d.label == "sqll_test"));

            let groups = children(&cfg, &pool, &nref("database", Some("sqll_test"), None, None, None)).await.unwrap();
            println!("groups: {:?}", groups.iter().map(|g| (&g.label, g.count)).collect::<Vec<_>>());
            let tables = children(&cfg, &pool, &nref("group", Some("sqll_test"), None, None, Some("table"))).await.unwrap();
            println!("tables: {:?}", tables.iter().map(|t| &t.label).collect::<Vec<_>>());
            let tref = nref("table", Some("sqll_test"), None, Some("documents"), None);
            assert!(tables.iter().any(|t| t.label == "documents"));

            let cols = columns(&cfg, &pool, &tref).await.unwrap();
            println!("columns: {:?}", cols.iter().map(|c| (&c.name, &c.type_name, c.primary_key)).collect::<Vec<_>>());
            assert_eq!(cols.len(), 6, "MySQL 表字段数不对");
            assert!(cols.iter().any(|c| c.name == "id" && c.primary_key));

            let rs = rows(&cfg, &pool, &tref, 10, 0, Some("id"), true, None).await.unwrap();
            println!("rows cols={:?} n={} total={:?}", rs.columns, rs.rows.len(), rs.total);
            assert_eq!(rs.columns, vec!["id", "title", "body", "meta", "score", "created"]);
            assert_eq!(rs.rows.len(), 2);
            assert_eq!(rs.total, Some(2));

            let filtered = rows(&cfg, &pool, &tref, 10, 0, Some("id"), false, Some("mastra")).await.unwrap();
            println!("filtered n={}", filtered.rows.len());
            assert_eq!(filtered.rows.len(), 1, "MySQL 筛选应只命中 1 行");

            let idx = indexes(&cfg, &pool, &tref).await.unwrap();
            println!("indexes: {:?}", idx.iter().map(|i| (&i.name, i.primary)).collect::<Vec<_>>());
            assert!(idx.iter().any(|i| i.primary));

            let d = ddl(&cfg, &pool, &tref).await.unwrap();
            println!("ddl generated={}", d.generated);
            assert!(d.sql.contains("CREATE TABLE"));

            let q = exec(&pool, "select count(*) as n from documents", true).await.unwrap();
            assert!(q.is_query);
            let denied = exec(&pool, "delete from documents", false).await;
            assert!(denied.is_err(), "只读连接应拒绝写操作");

            let keys = vec![KeyValue { column: "id".into(), value: "1".into() }];
            let preview = update_sql(&cfg, &pool, &tref, &keys, "title", Some("x'y")).await.unwrap();
            println!("update preview: {preview}");
            assert!(preview.contains("cast(`id` as char) = '1'"));
            assert!(preview.contains("'x''y'"));

            let exp = export_csv(&cfg, &pool, &tref, 100).await.unwrap();
            println!("csv: {} rows={}", exp.path, exp.rows);
            assert_eq!(exp.rows, 2);
            let _ = std::fs::remove_file(&exp.path);

            pool.close().await;
        });
    }

    fn pg_cfg() -> ConnectionConfig {
        ConnectionConfig {
            id: "p".into(),
            name: "p".into(),
            kind: "postgres".into(),
            host: "127.0.0.1".into(),
            port: 5432,
            database: Some("postgres".into()),
            user: Some(std::env::var("USER").unwrap_or_else(|_| "postgres".into())),
            ssl_mode: "disabled".into(),
            ca_path: None,
            color: None,
            read_only: None,
            production: None,
            file_path: None,
            has_password: false,
        }
    }

    fn rt() -> tokio::runtime::Runtime {
        sqlx::any::install_default_drivers();
        tokio::runtime::Runtime::new().unwrap()
    }

    async fn exec(pool: &AnyPool, sql: &str, allow_write: bool) -> Result<SqlResult, String> {
        let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
        execute_on(&mut conn, sql, allow_write).await
    }

    #[test]
    fn split_statements_cases() {
        assert_eq!(split_statements("select 1; select 2;").len(), 2);
        assert_eq!(split_statements("select ';' as a; select 2").len(), 2);
        assert_eq!(split_statements("select 1 -- ; not a split\n; select 2").len(), 2);
        assert_eq!(split_statements("select /* ; */ 1;").len(), 1);
        assert_eq!(
            split_statements("create function f() returns int as $$ begin return 1; end $$ language plpgsql; select 2")
                .len(),
            2
        );
        assert_eq!(split_statements("select 1;;;").len(), 1);
        assert_eq!(split_statements("  ").len(), 0);
    }

    fn nref(kind: &str, db: Option<&str>, schema: Option<&str>, name: Option<&str>, group: Option<&str>) -> NodeRef {
        NodeRef {
            kind: kind.into(),
            database: db.map(|s| s.to_string()),
            schema: schema.map(|s| s.to_string()),
            name: name.map(|s| s.to_string()),
            group: group.map(|s| s.to_string()),
        }
    }

    #[test]
    fn sqlite_roundtrip() {
        let dir = std::env::temp_dir().join(format!("sqll-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("demo.sqlite").to_string_lossy().to_string();
        rt().block_on(async {
            let cfg = sqlite_cfg(&path);
            let pool = connect(&cfg, None, None).await.unwrap();
            sqlx::query("create table users(id integer primary key, name text, score real, active integer, note text)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("insert into users values (1,'alice',9.5,1,null),(2,'bob',7.25,0,'x')")
                .execute(&pool)
                .await
                .unwrap();

            let dbs = children(&cfg, &pool, &nref("server", None, None, None, None)).await.unwrap();
            assert_eq!(dbs.len(), 1, "sqlite 应只有一个库节点");

            let groups = children(&cfg, &pool, &nref("database", Some("main"), None, None, None)).await.unwrap();
            let table_group = groups.iter().find(|g| g.label == "表").expect("缺少表分组");
            assert_eq!(table_group.count, Some(1));

            let items = children(&cfg, &pool, &nref("group", Some("main"), None, None, Some("table"))).await.unwrap();
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].label, "users");

            let cols = columns(&cfg, &pool, &nref("table", Some("main"), None, Some("users"), None)).await.unwrap();
            assert_eq!(cols.len(), 5);
            assert!(cols[0].primary_key);

            sqlx::query("create index idx_users_name on users(name)")
                .execute(&pool)
                .await
                .unwrap();
            let src_table = nref("table", Some("main"), None, Some("users"), None);
            let idx = indexes(&cfg, &pool, &src_table).await.unwrap();
            assert!(idx.iter().any(|i| i.primary), "sqlite 主键应被识别为索引");
            assert!(idx.iter().any(|i| i.name == "idx_users_name" && i.columns == vec!["name"]));
            let _fks = foreign_keys(&cfg, &pool, &src_table).await.unwrap();
            let d = ddl(&cfg, &pool, &src_table).await.unwrap();
            assert!(d.sql.contains("create table") || d.sql.contains("CREATE TABLE"));
            assert!(!d.generated);

            let rs = rows(&cfg, &pool, &nref("table", Some("main"), None, Some("users"), None), 100, 0, None, false, None).await.unwrap();
            assert_eq!(rs.columns, vec!["id", "name", "score", "active", "note"]);
            assert_eq!(rs.rows.len(), 2);
            assert!(matches!(rs.rows[0][0], CellValue::Int(1)));
            assert!(matches!(rs.rows[0][1], CellValue::Text(ref s) if s == "alice"));
            assert!(matches!(rs.rows[0][4], CellValue::Null));
            assert_eq!(rs.total, Some(2), "未筛选时总数应为 2");

            let rs_sort = rows(
                &cfg,
                &pool,
                &nref("table", Some("main"), None, Some("users"), None),
                100,
                0,
                Some("score"),
                true,
                None,
            )
            .await
            .unwrap();
            assert_eq!(rs_sort.rows.len(), 2);
            assert!(matches!(rs_sort.rows[0][0], CellValue::Int(1)), "按 score 倒序应 alice 在前");

            let rs_filter = rows(
                &cfg,
                &pool,
                &nref("table", Some("main"), None, Some("users"), None),
                100,
                0,
                None,
                false,
                Some("ali"),
            )
            .await
            .unwrap();
            assert_eq!(rs_filter.rows.len(), 1);
            assert_eq!(rs_filter.total, Some(1));

            let q = exec(&pool, "select count(*) as n from users", true).await.unwrap();
            assert!(q.is_query);
            assert_eq!(q.columns, vec!["n"]);
            let upd = exec(&pool, "update users set note = 'y'; update users set score = 9 where id = 2", true)
                .await
                .unwrap();
            assert_eq!(upd.executed, 2);
            assert_eq!(upd.affected, Some(3), "两条 UPDATE 影响行数应累加（2 + 1）");
            assert!(!upd.is_query);
            // 新增 / 删除：字面量 SQL 生成后直接执行
            let ins = insert_sql(
                &cfg,
                &pool,
                &src_table,
                &[KeyValue { column: "id".into(), value: "3".into() },
                  KeyValue { column: "name".into(), value: "o'hara".into() }],
            )
            .await
            .unwrap();
            assert!(ins.contains("'o''hara'"), "文本值应双写单引号：{ins}");
            let n = update_apply(&pool, &ins).await.unwrap();
            assert_eq!(n, 1);
            let count_after = exec(&pool, "select count(*) as n from users", true).await.unwrap();
            let nrow = match &count_after.rows[0][0] {
                crate::model::CellValue::Int(v) => *v,
                _ => 0,
            };
            assert_eq!(nrow, 3, "INSERT 后应有 3 行");
            let snap = snapshot_inserts(
                &cfg,
                &pool,
                &src_table,
                &[vec![KeyValue { column: "id".into(), value: "3".into() }]],
            )
            .await
            .unwrap();
            assert_eq!(snap.len(), 1, "删除前应拍下一行快照");
            assert!(snap[0].contains("insert into"), "快照应是 INSERT：{}", snap[0]);
            let del = delete_sql(&cfg, &pool, &src_table, &[KeyValue { column: "id".into(), value: "3".into() }])
                .await
                .unwrap();
            assert!(
                del.starts_with("delete from") && del.contains("where cast("),
                "实际：{del}"
            );
            let d = update_apply(&pool, &del).await.unwrap();
            assert_eq!(d, 1, "DELETE 应只删一行");
            // 撤销：快照 INSERT 执行回去
            update_apply(&pool, &snap[0]).await.unwrap();
            let restored = exec(&pool, "select count(*) as n from users", true).await.unwrap();
            assert_eq!(
                match &restored.rows[0][0] { CellValue::Int(v) => *v, _ => 0 },
                3,
                "撤销后应恢复为 3 行"
            );
            let schema = schema_map(&cfg, &pool, &nref("schema", Some("main"), None, None, None)).await.unwrap();
            assert!(
                schema.iter().any(|t| t.name == "users" && t.columns.contains(&"name".to_string())),
                "整库表结构应包含 users.name"
            );

            // 多行删除：两条主键用 OR 连接，一次执行
            for (id, name) in [("4", "bob"), ("5", "carol")] {
                let sql = insert_sql(
                    &cfg,
                    &pool,
                    &src_table,
                    &[KeyValue { column: "id".into(), value: id.into() },
                      KeyValue { column: "name".into(), value: name.into() }],
                )
                .await
                .unwrap();
                update_apply(&pool, &sql).await.unwrap();
            }
            let many = delete_many_sql(
                &cfg,
                &pool,
                &src_table,
                &[
                    vec![KeyValue { column: "id".into(), value: "4".into() }],
                    vec![KeyValue { column: "id".into(), value: "5".into() }],
                ],
            )
            .await
            .unwrap();
            assert!(many.contains(" or "), "多行条件应用 OR 连接：{many}");
            let dm = update_apply(&pool, &many).await.unwrap();
            assert_eq!(dm, 2, "多行删除应删掉 2 行");

            let denied = exec(&pool, "delete from users", false).await;
            assert!(denied.is_err(), "只读连接应拒绝写操作");

            let keys = vec![KeyValue {
                column: "id".into(),
                value: "1".into(),
            }];
            let upd_sql = update_sql(&cfg, &pool, &src_table, &keys, "name", Some("alice2"))
                .await
                .unwrap();
            assert!(upd_sql.starts_with("UPDATE"));
            assert!(upd_sql.contains("'alice2'"), "文本值应加引号：{upd_sql}");
            assert_eq!(update_apply(&pool, &upd_sql).await.unwrap(), 1);

            let null_sql = update_sql(&cfg, &pool, &src_table, &keys, "note", None)
                .await
                .unwrap();
            assert!(null_sql.contains("NULL"));

            let exp = export_csv(&cfg, &pool, &src_table, 100).await.unwrap();
            let text = std::fs::read_to_string(&exp.path).unwrap();
            assert!(text.starts_with("id,name,score,active,note"), "CSV 表头不对：{text}");
            assert_eq!(exp.rows, 3);
            let _ = std::fs::remove_file(&exp.path);
            pool.close().await;
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn postgres_cancel_probe() {
        if std::env::var("SQLL_TEST_PG").is_err() {
            return;
        }
        rt().block_on(async {
            let cfg = pg_cfg();
            let pool = connect(&cfg, None, None).await.unwrap();
            let mut slow = pool.acquire().await.unwrap();
            let pid: i64 = sqlx::query("select pg_backend_pid()")
                .fetch_one(&mut *slow)
                .await
                .unwrap()
                .try_get(0)
                .unwrap();
            let handle = tokio::spawn(async move {
                sqlx::query("select pg_sleep(8)").execute(&mut *slow).await
            });
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let mut killer = pool.acquire().await.unwrap();
            sqlx::query("select pg_cancel_backend($1)")
                .bind(pid as i32)
                .execute(&mut *killer)
                .await
                .unwrap();
            let err = handle.await.unwrap().unwrap_err();
            println!("cancel error: {err}");
            assert!(
                err.to_string().contains("canceling"),
                "取消后应返回 canceling statement 错误"
            );
            assert_eq!(friendly_error(&err.to_string()), "查询已取消");
        });
    }

    #[test]
    fn postgres_probe() {
        if std::env::var("SQLL_TEST_PG").is_err() {
            return;
        }
        rt().block_on(async {
            let cfg = pg_cfg();
            let pool = connect(&cfg, None, None).await.unwrap();
            let v = server_version(&pool, "postgres").await.unwrap();
            println!("PG version: {v}");

            let dbs = children(&cfg, &pool, &nref("server", None, None, None, None)).await.unwrap();
            println!("PG databases: {:?}", dbs.iter().map(|d| &d.label).collect::<Vec<_>>());
            assert!(!dbs.is_empty());

            let db = dbs.iter().find(|d| d.label != "postgres").map(|d| d.label.clone());
            if let Some(db) = db {
                let p2 = connect(&cfg, None, Some(&db)).await.unwrap();
                let schemas = children(&cfg, &p2, &nref("database", Some(&db), None, None, None)).await.unwrap();
                println!("schemas in {db}: {:?}", schemas.iter().map(|d| &d.label).collect::<Vec<_>>());
                if let Some(schema) = schemas.iter().find(|x| x.label == "public") {
                    let groups = children(&cfg, &p2, &nref("schema", Some(&db), Some("public"), None, None)).await.unwrap();
                    println!("groups: {:?}", groups.iter().map(|g| (&g.label, g.count)).collect::<Vec<_>>());
                    if let Some(tg) = groups.iter().find(|g| g.label == "表") {
                        let items = children(&cfg, &p2, &nref("group", Some(&db), Some("public"), None, Some("table"))).await.unwrap();
                        println!("tables in {db}.public: {:?}", items.iter().map(|i| &i.label).collect::<Vec<_>>());
                        if let Some(first) = items.first() {
                            let cols = columns(&cfg, &p2, &nref("table", Some(&db), Some("public"), Some(&first.label), None)).await.unwrap();
                            println!("columns of {}: {:?}", first.label, cols.iter().map(|c| (&c.name, &c.type_name)).collect::<Vec<_>>());
                            let ins_probe = insert_sql(
                &cfg,
                &p2,
                &nref("table", Some(&db), Some("public"), Some(&first.label), None),
                &[],
            )
            .await
            .unwrap();
            println!("PG insert sql: {ins_probe}");
            assert!(ins_probe.contains("insert into"));
            let rs = rows(&cfg, &p2, &nref("table", Some(&db), Some("public"), Some(&first.label), None), 5, 0, None, false, None).await.unwrap();
                            println!("rows cols={:?} n={}", rs.columns, rs.rows.len());
                            let tref = nref("table", Some(&db), Some("public"), Some(&first.label), None);
                            let idx = indexes(&cfg, &p2, &tref).await.unwrap();
                            println!("indexes: {:?}", idx.iter().map(|i| (&i.name, i.primary, &i.columns)).collect::<Vec<_>>());
                            assert!(!idx.is_empty(), "PG 表应至少有一个主键索引");
                            let fks = foreign_keys(&cfg, &p2, &tref).await.unwrap();
                            println!("fks: {:?}", fks.iter().map(|f| (&f.name, &f.columns, &f.ref_table)).collect::<Vec<_>>());
                            let d = ddl(&cfg, &p2, &tref).await.unwrap();
                            println!("ddl generated={} {}", d.generated, d.sql.replace('\n', " | "));
                            assert!(d.generated, "PG DDL 应为拼装生成");
                            assert!(d.sql.contains("CREATE TABLE"));
                            let rs_sorted = rows(
                                &cfg,
                                &p2,
                                &tref,
                                5,
                                0,
                                Some("id"),
                                true,
                                None,
                            )
                            .await
                            .unwrap();
                            println!("sorted rows={} total={:?}", rs_sorted.rows.len(), rs_sorted.total);
                            let q = exec(&p2, "select count(*) as n from rag_documents", true).await.unwrap();
                            assert!(q.is_query);

                            // 只生成预览，不真正改用户数据
                            let keys = vec![KeyValue { column: "id".into(), value: "1".into() }];
                            let preview = update_sql(&cfg, &p2, &tref, &keys, "content", Some("x'y"))
                                .await
                                .unwrap();
                            println!("update preview: {preview}");
                            assert!(preview.contains("\"id\"::text = '1'"));
                            assert!(preview.contains("'x''y'"), "单引号应被转义");

                            let exp = export_csv(&cfg, &p2, &tref, 100).await.unwrap();
                            println!("csv: {} rows={}", exp.path, exp.rows);
                            assert!(exp.rows >= 1);
                            let _ = std::fs::remove_file(&exp.path);
                        }
                        let _ = (schema, tg);
                    }
                }
                p2.close().await;
            }
            pool.close().await;
        });
    }
}

/// MySQL 专用执行路径。
///
/// `sqlx::Any` 对 MySQL 的 `TIMESTAMP` / `DATETIME` 没有映射，`SELECT *` 命中这类列会
/// 在取数阶段直接报 `Any driver does not support MySql type Timestamp`。因此 MySQL 连接
/// 走原生 `MySqlConnection`，并按列类型逐级尝试解码，保证 `SELECT *` 能正常出结果。
pub async fn execute_on_mysql(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
    allow_write: bool,
) -> Result<SqlResult, String> {
    let stmts = split_statements(sql);
    if stmts.is_empty() {
        return Err("请输入要执行的 SQL".to_string());
    }

    let start = Instant::now();
    let fetched_at = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

    if !allow_write {
        for st in &stmts {
            if !is_query_stmt(st) {
                return Err("当前连接标记为「只读」，已阻止写操作".to_string());
            }
        }
    }

    let mut total_affected: u64 = 0;
    let mut last: Option<SqlResult> = None;
    for (idx, st) in stmts.iter().enumerate() {
        let query_stmt = is_query_stmt(st);
        let res = if query_stmt {
            let data = sqlx::query(st)
                .fetch_all(&mut *conn)
                .await
                .map_err(|e| {
                    format!(
                        "第 {} 条语句执行失败：{}",
                        idx + 1,
                        friendly_error(&e.to_string())
                    )
                })?;
            let columns: Vec<String> = data
                .first()
                .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let rows = data
                .iter()
                .map(|r| (0..r.len()).map(|i| cell_mysql(r, i)).collect())
                .collect();
            SqlResult {
                columns,
                rows,
                elapsed_ms: 0,
                fetched_at: fetched_at.clone(),
                affected: None,
                is_query: true,
                executed: 1,
                notice: None,
            }
        } else {
            let r = sqlx::query(st)
                .execute(&mut *conn)
                .await
                .map_err(|e| {
                    format!(
                        "第 {} 条语句执行失败：{}",
                        idx + 1,
                        friendly_error(&e.to_string())
                    )
                })?;
            total_affected += r.rows_affected();
            SqlResult {
                columns: Vec::new(),
                rows: Vec::new(),
                elapsed_ms: 0,
                fetched_at: fetched_at.clone(),
                affected: Some(r.rows_affected()),
                is_query: false,
                executed: 1,
                notice: None,
            }
        };
        last = Some(res);
    }

    let mut result = last.unwrap_or(SqlResult {
        columns: Vec::new(),
        rows: Vec::new(),
        elapsed_ms: 0,
        fetched_at,
        affected: None,
        is_query: true,
        executed: 0,
        notice: None,
    });
    result.elapsed_ms = start.elapsed().as_millis();
    result.executed = stmts.len() as u32;
    if stmts.len() > 1 {
        let rows = if result.is_query {
            format!("最后一条返回 {} 行", result.rows.len())
        } else {
            format!("累计影响 {total_affected} 行")
        };
        result.notice = Some(format!("共执行 {} 条语句，{rows}", stmts.len()));
        if !result.is_query {
            result.affected = Some(total_affected);
        }
    }
    Ok(result)
}

/// MySQL 行解码：NULL 优先，其次按文本 / 整数 / 浮点 / 布尔 / 二进制 / 日期时间兜底。
fn cell_mysql(row: &sqlx::mysql::MySqlRow, i: usize) -> CellValue {
    use sqlx::Row as _;
    match row.try_get_raw(i) {
        Ok(raw) if raw.is_null() => return CellValue::Null,
        Err(_) => return CellValue::Null,
        _ => {}
    }
    if let Ok(v) = row.try_get::<String, _>(i) {
        return CellValue::Text(v);
    }
    if let Ok(v) = row.try_get::<i64, _>(i) {
        return CellValue::Int(v);
    }
    if let Ok(v) = row.try_get::<f64, _>(i) {
        return CellValue::Float(v);
    }
    if let Ok(v) = row.try_get::<bool, _>(i) {
        return CellValue::Bool(v);
    }
    if let Ok(v) = row.try_get::<chrono::NaiveDateTime, _>(i) {
        return CellValue::Text(v.format("%Y-%m-%d %H:%M:%S").to_string());
    }
    if let Ok(v) = row.try_get::<chrono::NaiveDate, _>(i) {
        return CellValue::Text(v.format("%Y-%m-%d").to_string());
    }
    if let Ok(v) = row.try_get::<chrono::NaiveTime, _>(i) {
        return CellValue::Text(v.format("%H:%M:%S").to_string());
    }
    if let Ok(v) = row.try_get::<Vec<u8>, _>(i) {
        return CellValue::Binary(v.len());
    }
    CellValue::Null
}
