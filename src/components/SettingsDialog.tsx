/**
 * 设置弹窗：每页行数、编辑器字号、主题三档（浅色 / 深色 / 跟随系统）。
 * 保存即写入 localStorage，并对已打开的标签立即生效。
 */

import { useEffect } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { APP_REPOSITORY, APP_VERSION } from '@/types';
import { inTauri, errMessage } from '@/services/ipc';
import { useAppStore } from '@/store';
import s from './SettingsDialog.module.css';

const PAGE_SIZES = [50, 100, 200, 500];
const FONT_SIZES = [11, 12, 13, 14];

export function SettingsDialog() {
  const open = useAppStore((x) => x.settingsOpen);
  const close = useAppStore((x) => x.closeSettings);
  const settings = useAppStore((x) => x.settings);
  const save = useAppStore((x) => x.saveSettings);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;

  // 浏览器预览时没有 Tauri 运行时，退化成本地复制
  const openRepo = async () => {
    if (!inTauri) {
      await copyRepo();
      return;
    }
    try {
      await openUrl(APP_REPOSITORY);
    } catch (e) {
      useAppStore.getState().notify(`打开失败：${errMessage(e)}`);
    }
  };

  const copyRepo = async () => {
    try {
      await navigator.clipboard.writeText(APP_REPOSITORY);
      useAppStore.getState().notify('仓库地址已复制');
    } catch {
      useAppStore.getState().notify('复制失败，请手动选择地址');
    }
  };

  return (
    <div className={s.mask} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={s.card} role="dialog" aria-modal="true" aria-label="设置">
        <div className={s.head}>
          <div className={s.title}>设置</div>
          <button className={s.close} onClick={close} aria-label="关闭">
            ×
          </button>
        </div>

        <div className={s.body}>
          <div className={s.row}>
            <div className={s.label}>
              <div className={s.labelText}>默认每页行数</div>
              <div className={s.labelHint}>新打开的表按这个行数取数，已打开的表不受影响</div>
            </div>
            <div className={s.seg}>
              {PAGE_SIZES.map((n) => (
                <button
                  key={n}
                  className={`${s.segBtn} ${settings.pageSize === n ? s.segOn : ''}`}
                  onClick={() => save({ pageSize: n })}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div className={s.row}>
            <div className={s.label}>
              <div className={s.labelText}>SQL 编辑器字号</div>
              <div className={s.labelHint}>立即生效，写入本地配置</div>
            </div>
            <div className={s.seg}>
              {FONT_SIZES.map((n) => (
                <button
                  key={n}
                  className={`${s.segBtn} ${settings.editorFontSize === n ? s.segOn : ''}`}
                  onClick={() => save({ editorFontSize: n })}
                >
                  {n}px
                </button>
              ))}
            </div>
          </div>

          <div className={s.row}>
            <div className={s.label}>
              <div className={s.labelText}>主题</div>
              <div className={s.labelHint}>深色沿用同一套红橙强调；跟随系统会随 macOS 外观自动切换</div>
            </div>
            <div className={s.seg}>
              {(['light', 'dark', 'system'] as const).map((t) => (
                <button
                  key={t}
                  className={`${s.segBtn} ${settings.theme === t ? s.segOn : s.segOff}`}
                  onClick={() => save({ theme: t })}
                >
                  {t === 'light' ? '浅色' : t === 'dark' ? '深色' : '跟随系统'}
                </button>
              ))}
            </div>
          </div>

          <div className={s.row}>
            <div className={s.label}>
              <div className={s.labelText}>项目仓库</div>
              <div className={s.labelHint}>查看源码、提交问题与反馈</div>
            </div>
            <div className={s.repo}>
              <button className={s.repoLink} onClick={() => void openRepo()} title="在浏览器中打开仓库">
                {APP_REPOSITORY.replace(/^https?:\/\//, '')}
              </button>
              <button className={s.repoCopy} onClick={() => void copyRepo()}>
                复制
              </button>
            </div>
          </div>
        </div>

        <div className={s.foot}>
          <span className={s.ver}>SQLL v{APP_VERSION}</span>
          <span className={s.footHint}>配置文件：本地 localStorage（不落密码）</span>
        </div>
      </div>
    </div>
  );
}
