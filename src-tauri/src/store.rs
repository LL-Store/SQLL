//! 连接配置的落盘与密码保管。
//!
//! 配置写 `app_data_dir/connections.json`（明文，但不含密码）；
//! 密码优先放系统钥匙串，钥匙串不可用时退化为进程内缓存，绝不写进文件。

use crate::model::ConnectionConfig;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "com.llstore.sqll";

pub fn data_file(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = fs::create_dir_all(&dir);
    dir.join("connections.json")
}

pub fn load(app: &AppHandle) -> Vec<ConnectionConfig> {
    let path = data_file(app);
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let list: Vec<ConnectionConfig> = serde_json::from_str(&text).unwrap_or_default();
    migrate_legacy_vault(&list);
    list
}

/// 旧版本把数据库密码存在无后缀的钥匙串条目上；现在拆成 `:db` / `:ssh` 两个条目。
/// 启动时把每个连接遗留的旧键密码迁移到 `:db` 键，避免升级后已保存的密码读不到。
fn migrate_legacy_vault(list: &[ConnectionConfig]) {
    for cfg in list {
        let legacy_key = cfg.id.as_str();
        let db_key = format!("{legacy_key}{DB_SUFFIX}");
        let legacy_entry = keyring::Entry::new(KEYRING_SERVICE, legacy_key).ok();
        let Some(legacy_entry) = legacy_entry else { continue };
        let Ok(pw) = legacy_entry.get_password() else { continue };
        if let Some(db_entry) = keyring::Entry::new(KEYRING_SERVICE, &db_key).ok() {
            let _ = db_entry.set_password(&pw);
        }
        let _ = legacy_entry.delete_credential();
    }
}

pub fn save(app: &AppHandle, list: &[ConnectionConfig]) -> Result<(), String> {
    let path = data_file(app);
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())
}

/// 密码优先存系统钥匙串；钥匙串不可用时退化为进程内缓存（绝不落盘明文）。
/// 同一连接可存两类口令：数据库密码与 SSH 跳板机密码，用后缀区分钥匙串条目。
pub struct Vault {
    mem: Mutex<HashMap<String, String>>,
}

/// 钥匙串条目的命名空间后缀，避免两类口令写到同一个条目。
const DB_SUFFIX: &str = ":db";
const SSH_SUFFIX: &str = ":ssh";

impl Vault {
    pub fn new() -> Self {
        Self {
            mem: Mutex::new(HashMap::new()),
        }
    }

    fn entry(id: &str) -> Option<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, id).ok()
    }

    fn slot(id: &str, suffix: &str) -> String {
        format!("{id}{suffix}")
    }

    /// 存数据库密码
    pub fn set(&self, id: &str, password: &str) {
        self.set_slot(id, DB_SUFFIX, password);
    }

    /// 存 SSH 跳板机密码
    pub fn set_ssh(&self, id: &str, password: &str) {
        self.set_slot(id, SSH_SUFFIX, password);
    }

    fn set_slot(&self, id: &str, suffix: &str, password: &str) {
        let key = Self::slot(id, suffix);
        if let Some(entry) = Self::entry(&key) {
            if entry.set_password(password).is_ok() {
                if let Ok(mut mem) = self.mem.lock() {
                    mem.remove(&key);
                }
                return;
            }
        }
        if let Ok(mut mem) = self.mem.lock() {
            mem.insert(key, password.to_string());
        }
    }

    /// 取数据库密码
    pub fn get(&self, id: &str) -> Option<String> {
        self.get_slot(id, DB_SUFFIX)
    }

    /// 取 SSH 跳板机密码
    pub fn get_ssh(&self, id: &str) -> Option<String> {
        self.get_slot(id, SSH_SUFFIX)
    }

    fn get_slot(&self, id: &str, suffix: &str) -> Option<String> {
        let key = Self::slot(id, suffix);
        if let Some(entry) = Self::entry(&key) {
            if let Ok(pw) = entry.get_password() {
                return Some(pw);
            }
        }
        self.mem.lock().ok().and_then(|m| m.get(&key).cloned())
    }

    /// 清掉某连接的 SSH 口令（关闭隧道时调用），数据库密码保留。
    pub fn remove_ssh(&self, id: &str) {
        let key = Self::slot(id, SSH_SUFFIX);
        if let Some(entry) = Self::entry(&key) {
            let _ = entry.delete_credential();
        }
        if let Ok(mut mem) = self.mem.lock() {
            mem.remove(&key);
        }
    }

    pub fn remove(&self, id: &str) {
        for suffix in [DB_SUFFIX, SSH_SUFFIX] {
            let key = Self::slot(id, suffix);
            if let Some(entry) = Self::entry(&key) {
                let _ = entry.delete_credential();
            }
            if let Ok(mut mem) = self.mem.lock() {
                mem.remove(&key);
            }
        }
    }
}
