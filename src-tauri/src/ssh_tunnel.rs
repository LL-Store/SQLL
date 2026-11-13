//! SSH 隧道（可选）：通过跳板机把数据库端口转发到本地回环。
//!
//! sqlx 0.8 没有公开的「自定义连接流」接入点，内部直接 `TcpStream::connect`，
//! 因此这里采用经典的本地转发方案：
//! 1. 与跳板机建立一条 libssh2 会话（密码或私钥认证）；
//! 2. 在 `127.0.0.1` 上监听一个随机空闲端口；
//! 3. 每接受一条本地连接，就通过会话开一条 `direct-tcpip` 通道到数据库地址，
//!    然后在两个流之间双向拷贝数据；
//! 4. 数据库连接串的 host/port 改指本地转发端口即可。
//!
//! 会话与监听句柄随连接配置缓存（见 `AppCtx.tunnels`），删除连接时一并关闭。
//! libssh2 是同步阻塞 API，转发任务放在独立线程上跑，不阻塞 tokio 运行时。

use crate::model::ConnectionConfig;
use ssh2::Session;
use std::io;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

/// 一条存活的 SSH 隧道：本地监听端口 + 会话句柄。
/// 会话 `Session` 内部是 `Arc<Mutex<..>>`，可克隆；关闭时断开会话并停掉监听。
/// 接受线程是 `std::thread::spawn` 产生的普通线程（非 Send 约束的异步任务），句柄随结构体持有。
pub struct SshTunnel {
    local_port: u16,
    session: Session,
    listener: Arc<Mutex<Option<TcpListener>>>,
    /// 后台接受连接的转发线程；隧道关闭后随 listener drop 自然退出
    _worker: Option<JoinHandle<()>>,
}

impl SshTunnel {
    /// 隧道在本地的回环地址：sqlx 连这里，再经跳板机到数据库。
    pub fn local_addr(&self) -> (String, u16) {
        ("127.0.0.1".to_string(), self.local_port)
    }

    /// 关闭隧道：先停监听（新连接进不来），再断开 SSH 会话。
    pub fn close(&self) {
        if let Ok(mut l) = self.listener.lock() {
            *l = None;
        }
        let _ = self.session.disconnect(None, "客户端关闭连接", None);
    }
}

/// 判断这条配置是否启用了 SSH 隧道（SQLite 无网络隧道概念）。
pub fn enabled(cfg: &ConnectionConfig) -> bool {
    cfg.ssh_enabled && cfg.kind != "sqlite"
}

/// 默认私钥路径 `~/.ssh/id_rsa`。
fn default_private_key() -> Option<PathBuf> {
    dirs_home().map(|h| h.join(".ssh").join("id_rsa"))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// 把用户输入里开头的 `~/` 展开成家目录路径，其余原样返回。
fn expand_tilde(raw: &str) -> PathBuf {
    let rest = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~"));
    match (rest, dirs_home()) {
        (Some(rel), Some(home)) => home.join(rel),
        _ => PathBuf::from(raw),
    }
}

/// 建立隧道。`ssh_password` 仅密码认证时使用，来自钥匙串；
/// 私钥认证从文件读取，私钥口令本期暂不单独配置（无口令私钥为主流场景）。
pub fn open(
    cfg: &ConnectionConfig,
    ssh_password: Option<&str>,
    db_host: &str,
    db_port: u16,
) -> Result<SshTunnel, String> {
    let ssh_host = cfg
        .ssh_host
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "启用 SSH 隧道时需要填写跳板机主机".to_string())?;
    let ssh_port = if cfg.ssh_port > 0 { cfg.ssh_port } else { 22 };
    let ssh_user = cfg
        .ssh_user
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "启用 SSH 隧道时需要填写 SSH 用户名".to_string())?;

    // 1. TCP 连到跳板机（libssh2 阻塞，这里在调用方的异步任务里直接用 std 阻塞即可，
    //    隧道建立是一次性开销；超时由 set_timeout 兜底）
    let tcp = TcpStream::connect((ssh_host, ssh_port))
        .map_err(|e| format!("SSH 跳板机连接失败 {ssh_host}:{ssh_port}：{e}"))?;
    tcp.set_nodelay(true).ok();
    tcp.set_read_timeout(Some(std::time::Duration::from_secs(10))).ok();
    tcp.set_write_timeout(Some(std::time::Duration::from_secs(10))).ok();

    let mut sess = Session::new().map_err(|e| format!("初始化 SSH 会话失败：{e}"))?;
    sess.set_tcp_stream(tcp);
    sess.set_timeout(10_000);
    sess.handshake().map_err(|e| format!("SSH 握手失败：{e}"))?;

    // 2. 认证：密码 / 公钥
    if cfg.ssh_auth == "publickey" {
        let raw = cfg
            .ssh_key_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(expand_tilde)
            .or_else(default_private_key)
            .ok_or_else(|| "公钥认证需要选择私钥文件".to_string())?;
        sess.userauth_pubkey_file(ssh_user, None, &raw, None)
            .map_err(|e| format!("SSH 公钥认证失败：{e}"))?;
    } else {
        let pw = ssh_password.filter(|s| !s.is_empty()).ok_or_else(|| {
            "SSH 密码认证需要填写跳板机密码".to_string()
        })?;
        sess.userauth_password(ssh_user, pw)
            .map_err(|e| format!("SSH 密码认证失败：{e}"))?;
    }
    if !sess.authenticated() {
        return Err("SSH 认证未通过".to_string());
    }

    // 3. 本地监听随机端口
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("本地隧道端口监听失败：{e}"))?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener
        .set_nonblocking(false)
        .map_err(|e| e.to_string())?;

    let listener = Arc::new(Mutex::new(Some(listener)));

    // 4. 后台接受连接并转发。libssh2 阻塞，每连接再开一个线程做双向拷贝。
    let worker_listener = listener.clone();
    let worker_sess = sess.clone();
    let target_host = db_host.to_string();
    let target_port = db_port;
    let handle = thread::Builder::new()
        .name("sqll-ssh-tunnel".into())
        .spawn(move || {
            let listener = match worker_listener.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            let Some(listener) = listener.as_ref() else { return };
            // 接受循环：listener 被 drop（关闭隧道）时 accept 返回错误，循环退出
            for stream in listener.incoming() {
                let Ok(local) = stream else { break };
                let sess = worker_sess.clone();
                let host = target_host.clone();
                thread::spawn(move || {
                    if let Ok(chan) = sess.channel_direct_tcpip(&host, target_port, None) {
                        relay(local, chan);
                    }
                });
            }
        })
        .map_err(|e| format!("启动隧道转发线程失败：{e}"))?;

    Ok(SshTunnel {
        local_port,
        session: sess,
        listener,
        _worker: Some(handle),
    })
}

/// 在本地套接字与 SSH 通道之间双向拷贝，任一侧关闭后收尾。
fn relay(mut local: TcpStream, mut chan: ssh2::Channel) {
    // Channel 内部是 Arc 包装，Clone 出两个句柄分别负责一个方向的拷贝
    let mut local_a = local.try_clone().unwrap_or_else(|_| local.try_clone().unwrap());
    let mut chan_a = chan.clone();
    let mut chan_b = chan.clone();

    // local -> channel；channel -> local
    let t1 = thread::spawn(move || io::copy(&mut local_a, &mut chan_b).ok());
    let t2 = thread::spawn(move || io::copy(&mut chan_a, &mut local).ok());

    let _ = t1.join();
    let _ = t2.join();
    let _ = chan.close();
}
