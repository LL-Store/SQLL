/**
 * 自研右键菜单（替代 WebView 的系统菜单）。
 *
 * 两个要点：
 * - 用 `useLayoutEffect` 在渲染后量一次尺寸，把菜单夹回视口内，避免贴边溢出；
 * - 打开期间在 window 上以 capture 阶段监听 mousedown / Esc / blur 关闭，
 *   菜单内部点击不关闭（由菜单项自己先关再执行）。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import s from './ContextMenu.module.css';

export interface MenuItem {
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export interface MenuState {
  x: number;
  y: number;
  title?: string;
  items: MenuItem[];
}

export function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0, ready: false });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const el = ref.current;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // 先量实际尺寸再夹回视口：菜单可能在屏幕右下角弹出
    const left = Math.min(menu.x, window.innerWidth - w - 8);
    const top = Math.min(menu.y, window.innerHeight - h - 8);
    setPos({ left: Math.max(6, left), top: Math.max(6, top), ready: true });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // capture 阶段监听：子元素 stopPropagation 也不会漏掉「点外面关闭」
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  return (
    <div
      ref={ref}
      role="menu"
      className={s.menu}
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
    >
      {menu.title ? <div className={s.title}>{menu.title}</div> : null}
      {menu.items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={item.danger ? `${s.item} ${s.danger}` : s.item}
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onClick();
          }}
        >
          <span className={s.label}>{item.label}</span>
          {item.hint ? <span className={s.hint}>{item.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}
