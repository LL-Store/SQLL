//! 前后端共享的数据结构。
//!
//! 全部 `#[serde(rename_all = "camelCase")]`，字段名与 `src/types.ts` 一一对应；
//! 改这里就要同步改前端类型，否则序列化出来的字段前端读不到。
//! `CellValue` 用 `t` / `v` 两个字段打平，前端按 `cell.t` 分支渲染。

use serde::{Deserialize, Serialize};

/// 一个数据库连接的配置。密码不在这里：只存钥匙串，`has_password` 表示是否存在。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    /// mysql | postgres | sqlite
    pub kind: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    /// disabled | preferred | required | verify-ca | verify-full
    #[serde(default)]
    pub ssl_mode: String,
    #[serde(default)]
    pub ca_path: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub read_only: Option<bool>,
    #[serde(default)]
    pub production: Option<bool>,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub has_password: bool,
}

/// 「测试连接」的结果：服务端版本 + 握手耗时。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub version: String,
    pub latency_ms: u128,
}

/// 树的节点引用，前端原样回传即可定位下一层
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRef {
    /// server | database | schema | group | table
    pub kind: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// 仅 group 节点使用：table | view | function | procedure | trigger
    #[serde(default)]
    pub group: Option<String>,
}

/// 结构树的一个节点；`node` 原样回传就能定位下一层，前端不需要理解层级规则。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub id: String,
    /// database | schema | group | table | view | function | procedure | trigger
    pub kind: String,
    pub label: String,
    pub count: Option<i64>,
    pub expandable: bool,
    pub node: NodeRef,
}

/// 字段元数据（右侧字段面板与新增行表单都靠它）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub primary_key: bool,
    pub comment: Option<String>,
}

/// 索引元数据。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexMeta {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
    pub method: Option<String>,
}

/// 外键元数据。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyMeta {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_delete: Option<String>,
    pub on_update: Option<String>,
}

/// 建表语句（或对象定义），`generated` 标记是否是按元数据拼装出来的。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DdlResult {
    pub sql: String,
    /// true 表示由字段元数据拼装，不是数据库返回的原始 DDL
    pub generated: bool,
}

/// 单列的值：用于主键条件，也用于新增行 / 更新单元格的输入。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValue {
    pub column: String,
    pub value: String,
}

/// 删除结果：`undo_id` 非空时前端会显示「撤销」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub sql: String,
    pub applied: Option<u64>,
    /// 撤销令牌，前端「撤销」按钮用它回滚这一次删除
    pub undo_id: Option<String>,
}

/// 补全用的表结构：表名 + 字段名。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaTable {
    pub name: String,
    pub columns: Vec<String>,
}

/// 更新 / 新增的通用结果：预览时 `applied` 为空，执行后有值。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    /// 将要 / 已经执行的 UPDATE 语句，用于界面预览
    pub sql: String,
    /// 预览时为 None，执行后为影响行数
    pub applied: Option<u64>,
}

/// CSV 导出结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub rows: u32,
}

/// 单元格值。BLOB 只回长度（界面显示 `BLOB n B`），不把二进制塞进 JSON。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", content = "v", rename_all = "camelCase")]
pub enum CellValue {
    Null,
    Text(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    Binary(usize),
}

/// 表数据的一页。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<CellValue>>,
    pub elapsed_ms: u128,
    pub fetched_at: String,
    /// 当前筛选条件下的总行数；取不到时为 None
    pub total: Option<u32>,
}

/// SQL 编辑器的执行结果；多语句时只保留最后一条结果集。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<CellValue>>,
    pub elapsed_ms: u128,
    pub fetched_at: String,
    /// DDL / DML 的影响行数；查询语句为 None
    pub affected: Option<u64>,
    /// true = 查询结果集，false = 写语句的执行结果
    pub is_query: bool,
    /// 本次一共执行了几条语句（多语句用 ; 分隔时 > 1）
    pub executed: u32,
    /// 多语句时的汇总说明
    pub notice: Option<String>,
}
