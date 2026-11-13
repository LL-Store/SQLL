/**
 * 新建 / 编辑连接弹窗。
 *
 * 表单按数据库类型切换字段（SQLite 只要文件路径，MySQL / PG 要主机、端口、账号）；
 * 密码不回显，编辑时留空表示沿用原密码；生产连接需要额外确认写入风险。
 */

import { useEffect, useState } from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { api, errMessage } from '@/services/ipc';
import { DB_META, type ConnectionConfig, type DbKind, type SslMode } from '@/types';
import { useAppStore } from '@/store';
import s from './ConnectionDialog.module.css';

const SSL_MODES: { value: SslMode; label: string }[] = [
  { value: 'disabled', label: 'Disable' },
  { value: 'preferred', label: 'Prefer' },
  { value: 'required', label: 'Require' },
  { value: 'verify-ca', label: 'Verify CA' },
  { value: 'verify-full', label: 'Verify Full' },
];

const COLORS = ['#e5533d', '#e8a33d', '#3a82d8', '#5ba85b', '#8a8f99'];

export function ConnectionDialog() {
  const open = useAppStore((st) => st.dialogOpen);
  const editing = useAppStore((st) => st.editing);
  const close = useAppStore((st) => st.closeDialog);
  const save = useAppStore((st) => st.saveConnection);

  const [kind, setKind] = useState<DbKind>('mysql');
  const [name, setName] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('3306');
  const [database, setDatabase] = useState('');
  const [user, setUser] = useState('root');
  const [password, setPassword] = useState('');
  const [sslOn, setSslOn] = useState(false);
  const [sslMode, setSslMode] = useState<SslMode>('verify-ca');
  const [caPath, setCaPath] = useState('');
  const [filePath, setFilePath] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [readOnly, setReadOnly] = useState(false);
  const [production, setProduction] = useState(false);
  // SSH 隧道
  const [sshOn, setSshOn] = useState(false);
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('');
  const [sshAuth, setSshAuth] = useState<'password' | 'publickey'>('password');
  const [sshKeyPath, setSshKeyPath] = useState('');
  const [sshPassword, setSshPassword] = useState('');
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTestMsg(null);
    setSaving(false);
    // 每次打开都从配置重建表单：编辑时密码留空 = 沿用钥匙串里的原密码
    if (editing) {
      setKind(editing.kind);
      setName(editing.name);
      setHost(editing.host);
      setPort(String(editing.port || DB_META[editing.kind].defaultPort));
      setDatabase(editing.database ?? '');
      setUser(editing.user ?? 'root');
      setPassword('');
      setSslOn(editing.sslMode !== 'disabled');
      setSslMode((editing.sslMode || 'verify-ca') as SslMode);
      setCaPath(editing.caPath ?? '');
      setFilePath(editing.filePath ?? '');
      setColor(editing.color || COLORS[0]);
      setReadOnly(!!editing.readOnly);
      setProduction(!!editing.production);
      setSshOn(!!editing.sshEnabled);
      setSshHost(editing.sshHost ?? '');
      setSshPort(String(editing.sshPort || 22));
      setSshUser(editing.sshUser ?? '');
      setSshAuth(editing.sshAuth === 'publickey' ? 'publickey' : 'password');
      setSshKeyPath(editing.sshKeyPath ?? '');
      setSshPassword('');
    } else {
      setKind('mysql');
      setName('本地 MySQL · dev');
      setHost('127.0.0.1');
      setPort(String(DB_META.mysql.defaultPort));
      setDatabase('');
      setUser('root');
      setPassword('');
      setSslOn(false);
      setSslMode('verify-ca');
      setCaPath('');
      setFilePath('');
      setColor(COLORS[0]);
      setReadOnly(false);
      setProduction(false);
      setSshOn(false);
      setSshHost('');
      setSshPort('22');
      setSshUser('');
      setSshAuth('password');
      setSshKeyPath('');
      setSshPassword('');
    }
  }, [open, editing]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;

  const switchKind = (k: DbKind) => {
    setKind(k);
    setPort(String(DB_META[k].defaultPort));
    setName(k === 'sqlite' ? '本地 SQLite' : `本地 ${DB_META[k].label} · dev`);
    setTestMsg(null);
  };

  const sshEnabled = kind !== 'sqlite' && sshOn;

  const build = (): ConnectionConfig => ({
    id: editing?.id ?? '',
    name: name.trim(),
    kind,
    host: host.trim(),
    port: Number(port) || DB_META[kind].defaultPort,
    database: kind === 'sqlite' ? null : database.trim() || null,
    user: kind === 'sqlite' ? null : user.trim() || null,
    sslMode: kind === 'sqlite' || !sslOn ? 'disabled' : sslMode,
    caPath: kind !== 'sqlite' && sslOn && caPath.trim() ? caPath.trim() : null,
    color,
    readOnly,
    production,
    filePath: kind === 'sqlite' ? filePath.trim() : null,
    hasPassword: !!editing?.hasPassword || password.length > 0,
    sshEnabled,
    sshHost: sshEnabled ? sshHost.trim() || null : null,
    sshPort: sshEnabled ? Number(sshPort) || 22 : 0,
    sshUser: sshEnabled ? sshUser.trim() || null : null,
    sshAuth: sshEnabled ? sshAuth : 'password',
    sshKeyPath:
      sshEnabled && sshAuth === 'publickey' && sshKeyPath.trim() ? sshKeyPath.trim() : null,
  });

  const sshValid =
    !sshEnabled ||
    (sshHost.trim().length > 0 && Number(sshPort) > 0 && sshUser.trim().length > 0);

  const valid =
    name.trim().length > 0 &&
    sshValid &&
    (kind === 'sqlite' ? filePath.trim().length > 0 : host.trim().length > 0 && Number(port) > 0);

  const onTest = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const r = await api.testConnection(build(), password || undefined, sshPassword || undefined);
      setTestMsg({ ok: true, text: `连接成功 · ${r.version.slice(0, 48)} · ${r.latencyMs} ms` });
    } catch (e) {
      setTestMsg({ ok: false, text: errMessage(e) });
    } finally {
      setTesting(false);
    }
  };

  const onSave = async () => {
    setSaving(true);
    await save(build(), password || undefined, sshPassword || undefined);
    setSaving(false);
  };

  return (
    <div className={s.overlay} onMouseDown={close}>
      <div className={s.modal} onMouseDown={(e) => e.stopPropagation()}>
        <div className={s.head}>
          <span className={s.title}>{editing ? '编辑连接' : '新建连接'}</span>
          <span className={s.sub}>{DB_META[kind].label}</span>
          <button className={s.close} onClick={close} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className={s.body}>
          <div className={s.seg}>
            {(Object.keys(DB_META) as DbKind[]).map((k) => (
              <button
                key={k}
                className={kind === k ? `${s.segItem} ${s.segOn}` : s.segItem}
                onClick={() => switchKind(k)}
              >
                <span className={s.segDot} style={{ background: DB_META[k].color }} />
                {DB_META[k].label}
              </button>
            ))}
          </div>

          <div className={s.field}>
            <label className={s.label}>连接名称</label>
            <input className={s.input} value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          {kind === 'sqlite' ? (
            <div className={s.field}>
              <label className={s.label}>数据库文件</label>
              <div className={s.fileRow}>
                <input
                  className={s.input}
                  value={filePath}
                  placeholder="输入 .sqlite / .db 文件的绝对路径"
                  onChange={(e) => setFilePath(e.target.value)}
                />
                <button
                  className={s.pick}
                  onClick={() => {
                    // 走 Tauri 的文件选择器拿绝对路径；浏览器预览时该按钮不可用
                    void openFileDialog({
                      multiple: false,
                      directory: false,
                      filters: [{ name: 'SQLite 数据库', extensions: ['sqlite', 'sqlite3', 'db'] }],
                    }).then((p: string | string[] | null) => {
                      if (typeof p === 'string') setFilePath(p);
                    });
                  }}
                  title="选择本地的 SQLite 数据库文件"
                >
                  选择…
                </button>
              </div>
              <div className={s.sslNote} style={{ paddingTop: 6 }}>
                文件不存在时会自动创建（mode=rwc）
              </div>
            </div>
          ) : (
            <>
              <div className={s.row}>
                <div className={s.field} style={{ flex: 2.2 }}>
                  <label className={s.label}>主机</label>
                  <input className={s.input} value={host} onChange={(e) => setHost(e.target.value)} />
                </div>
                <div className={s.field} style={{ flex: 1 }}>
                  <label className={s.label}>端口</label>
                  <input className={s.input} value={port} onChange={(e) => setPort(e.target.value)} />
                </div>
              </div>

              <div className={s.row}>
                <div className={s.field}>
                  <label className={s.label}>数据库（可选）</label>
                  <input
                    className={s.input}
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                    placeholder={kind === 'postgres' ? '默认连接 postgres' : '留空则只连服务器'}
                  />
                </div>
                <div className={s.field}>
                  <label className={s.label}>用户名</label>
                  <input className={s.input} value={user} onChange={(e) => setUser(e.target.value)} />
                </div>
              </div>

              <div className={s.field}>
                <label className={s.label}>密码（保存在系统钥匙串）</label>
                <input
                  className={s.input}
                  type="password"
                  value={password}
                  placeholder={editing?.hasPassword ? '已保存，留空则不修改' : '请输入密码'}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>

              <div className={s.sslBox}>
                <div className={s.sslTop}>
                  SSL 连接
                  <button
                    className={sslOn ? s.switch : `${s.switch} ${s.switchOff}`}
                    onClick={() => setSslOn((v) => !v)}
                    aria-label="切换 SSL"
                  />
                </div>
                {sslOn ? (
                  <>
                    <div className={s.row}>
                      <div className={s.field}>
                        <label className={s.label}>SSL 模式</label>
                        <select
                          className={s.select}
                          value={sslMode}
                          onChange={(e) => setSslMode(e.target.value as SslMode)}
                        >
                          {SSL_MODES.map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className={s.field} style={{ flex: 1.4 }}>
                        <label className={s.label}>CA 证书（可选）</label>
                        <input
                          className={s.input}
                          value={caPath}
                          placeholder="~/certs/ca.pem"
                          onChange={(e) => setCaPath(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className={s.sslNote}>客户端证书 / 私钥为可选项，留空则仅校验服务端</div>
                  </>
                ) : null}
              </div>

              <div className={s.sshBox}>
                <div className={s.sslTop}>
                  SSH 隧道（经跳板机访问数据库）
                  <button
                    className={sshOn ? s.switch : `${s.switch} ${s.switchOff}`}
                    onClick={() => setSshOn((v) => !v)}
                    aria-label="切换 SSH 隧道"
                  />
                </div>
                {sshOn ? (
                  <>
                    <div className={s.row}>
                      <div className={s.field} style={{ flex: 2.2 }}>
                        <label className={s.label}>跳板机主机</label>
                        <input
                          className={s.input}
                          value={sshHost}
                          placeholder="如 10.0.0.8"
                          onChange={(e) => setSshHost(e.target.value)}
                        />
                      </div>
                      <div className={s.field} style={{ flex: 1 }}>
                        <label className={s.label}>端口</label>
                        <input
                          className={s.input}
                          value={sshPort}
                          onChange={(e) => setSshPort(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className={s.row}>
                      <div className={s.field}>
                        <label className={s.label}>SSH 用户名</label>
                        <input
                          className={s.input}
                          value={sshUser}
                          onChange={(e) => setSshUser(e.target.value)}
                        />
                      </div>
                      <div className={s.field}>
                        <label className={s.label}>认证方式</label>
                        <select
                          className={s.select}
                          value={sshAuth}
                          onChange={(e) => setSshAuth(e.target.value as 'password' | 'publickey')}
                        >
                          <option value="password">密码</option>
                          <option value="publickey">私钥</option>
                        </select>
                      </div>
                    </div>
                    {sshAuth === 'password' ? (
                      <div className={s.field}>
                        <label className={s.label}>SSH 密码（保存在系统钥匙串）</label>
                        <input
                          className={s.input}
                          type="password"
                          value={sshPassword}
                          placeholder={editing?.sshEnabled ? '已保存，留空则不修改' : '跳板机登录密码'}
                          onChange={(e) => setSshPassword(e.target.value)}
                        />
                      </div>
                    ) : (
                      <div className={s.field}>
                        <label className={s.label}>私钥文件（可选，留空读 ~/.ssh/id_rsa）</label>
                        <div className={s.fileRow}>
                          <input
                            className={s.input}
                            value={sshKeyPath}
                            placeholder="~/.ssh/id_rsa"
                            onChange={(e) => setSshKeyPath(e.target.value)}
                          />
                          <button
                            className={s.pick}
                            onClick={() => {
                              void openFileDialog({
                                multiple: false,
                                directory: false,
                                filters: [{ name: '私钥', extensions: ['pem', 'key', 'pub', 'rsa', 'ed25519'] }],
                              }).then((p: string | string[] | null) => {
                                if (typeof p === 'string') setSshKeyPath(p);
                              });
                            }}
                            title="选择 SSH 私钥文件"
                          >
                            选择…
                          </button>
                        </div>
                      </div>
                    )}
                    <div className={s.sslNote}>
                      连接时先登录跳板机，再由跳板机转发到上面填写的数据库地址
                    </div>
                  </>
                ) : null}
              </div>
            </>
          )}

          <div className={s.opts}>
            <span className={s.optLabel}>颜色标签</span>
            {COLORS.map((c) => (
              <button
                key={c}
                className={color === c ? `${s.swatch} ${s.swatchOn}` : s.swatch}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={`颜色 ${c}`}
              />
            ))}
            <label className={s.check} onClick={() => setReadOnly((v) => !v)}>
              <span className={readOnly ? `${s.cb} ${s.cbOn}` : s.cb} />
              只读连接
            </label>
            <label className={s.check} onClick={() => setProduction((v) => !v)}>
              <span className={production ? `${s.cb} ${s.cbOn}` : s.cb} />
              标记为生产
            </label>
          </div>

          {testMsg ? (
            <div className={testMsg.ok ? `${s.testMsg} ${s.testOk}` : `${s.testMsg} ${s.testErr}`}>
              {testMsg.text}
            </div>
          ) : null}
        </div>

        <div className={s.foot}>
          <button className={s.ghost} onClick={() => void onTest()} disabled={!valid || testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <span className={s.footNote}>密码不会写入配置文件</span>
          <button className={s.ghost} onClick={close}>
            取消
          </button>
          <button className={s.save} onClick={() => void onSave()} disabled={!valid || saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
