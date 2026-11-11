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
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save(app: &AppHandle, list: &[ConnectionConfig]) -> Result<(), String> {
    let path = data_file(app);
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())
}

/// 密码优先存系统钥匙串；钥匙串不可用时退化为进程内缓存（绝不落盘明文）
pub struct Vault {
    mem: Mutex<HashMap<String, String>>,
}

impl Vault {
    pub fn new() -> Self {
        Self {
            mem: Mutex::new(HashMap::new()),
        }
    }

    fn entry(id: &str) -> Option<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, id).ok()
    }

    pub fn set(&self, id: &str, password: &str) {
        if let Some(entry) = Self::entry(id) {
            if entry.set_password(password).is_ok() {
                if let Ok(mut mem) = self.mem.lock() {
                    mem.remove(id);
                }
                return;
            }
        }
        if let Ok(mut mem) = self.mem.lock() {
            mem.insert(id.to_string(), password.to_string());
        }
    }

    pub fn get(&self, id: &str) -> Option<String> {
        if let Some(entry) = Self::entry(id) {
            if let Ok(pw) = entry.get_password() {
                return Some(pw);
            }
        }
        self.mem.lock().ok().and_then(|m| m.get(id).cloned())
    }

    pub fn remove(&self, id: &str) {
        if let Some(entry) = Self::entry(id) {
            let _ = entry.delete_credential();
        }
        if let Ok(mut mem) = self.mem.lock() {
            mem.remove(id);
        }
    }
}
