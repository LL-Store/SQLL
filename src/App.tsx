/**
 * 应用根组件：三栏布局 + 全局弹窗 / toast / 撤销条。
 *
 * 这里只做「横切」的事：
 * - 主题解析：设置里的 light / dark / system 落到根节点的 data-theme，
 *   组件内所有颜色都取 CSS 变量，因此切主题不需要重建任何组件；
 * - 一次性提示的自动收起（toast 2.6s、撤销条 10s），避免一直挡着操作。
 */

import { useEffect } from 'react';
import styles from './App.module.css';
import { TitleBar } from './components/TitleBar';
import { Sidebar } from './components/Sidebar';
import { WorkArea } from './components/WorkArea';
import { Inspector } from './components/Inspector';
import { StatusBar } from './components/StatusBar';
import { ConnectionDialog } from './components/ConnectionDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { ObjectDialog } from './components/ObjectDialog';
import { CommandPalette } from './components/CommandPalette';
import { useAppStore } from './store';

export function App() {
  const toast = useAppStore((s) => s.toast);
  const theme = useAppStore((s) => s.settings.theme);
  const dismissToast = useAppStore((s) => s.dismissToast);
  const undo = useAppStore((s) => s.undo);
  const undoDelete = useAppStore((s) => s.undoDelete);
  const dismissUndo = useAppStore((s) => s.dismissUndo);

  useEffect(() => {
    void useAppStore.getState().boot();
  }, []);

  // 主题挂在根节点，tokens.css 的 [data-theme='dark'] 负责换令牌，
  // 组件里已统一走 var(--*) 的业务色随之切换
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      // system 档只在解析时读一次系统偏好，并监听后续变化；light / dark 不订阅
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    if (theme !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(dismissToast, 2600);
    return () => window.clearTimeout(timer);
  }, [toast, dismissToast]);

  // 撤销提示不挡操作，但也不该一直挂着：10 秒后自动收起
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(dismissUndo, 10000);
    return () => window.clearTimeout(timer);
  }, [undo, dismissUndo]);

  return (
    <div className={styles.app}>
      <TitleBar />
      <div className={styles.body}>
        <Sidebar />
        <WorkArea />
        <Inspector />
      </div>
      <StatusBar />
      <ConnectionDialog />
      <SettingsDialog />
      <ObjectDialog />
      {undo ? (
        <div className={styles.undoBar} role="status">
          <span>{undo.label}已执行，可撤销</span>
          <button className={styles.undoBtn} onClick={() => void undoDelete()}>
            撤销
          </button>
          <button className={styles.undoClose} onClick={dismissUndo} aria-label="关闭撤销提示">
            ✕
          </button>
        </div>
      ) : null}
      <CommandPalette />
      {toast ? (
        <div className={styles.toast} onClick={dismissToast}>
          {toast}
        </div>
      ) : null}
    </div>
  );
}
