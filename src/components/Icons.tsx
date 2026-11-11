/**
 * 内联 SVG 图标集合，避免为几个图标引入图标库。
 * `size` / `color` 由调用方传入，默认跟随主题文字色。
 */

import type { CSSProperties } from 'react';

type IconProps = {
  size?: number;
  color?: string;
  style?: CSSProperties;
};

const base = (size = 14) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none' as const,
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export function ServerIcon({ size, color = '#6b7280', style }: IconProps) {
  return (
    <svg {...base(size)} stroke={color} style={style}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

export function DatabaseIcon({ size, color = '#3a82d8', style }: IconProps) {
  return (
    <svg {...base(size)} stroke={color} style={style}>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
      <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </svg>
  );
}

export function TableIcon({ size, color = '#5b8fb9', style }: IconProps) {
  return (
    <svg {...base(size)} stroke={color} style={style}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 9v12" />
    </svg>
  );
}

export function ViewIcon({ size, color = '#c08a2e', style }: IconProps) {
  return (
    <svg {...base(size)} stroke={color} style={style}>
      <path d="M2 12s3.6-5.5 10-5.5S22 12 22 12 18.4 17.5 12 17.5 2 12 2 12z" />
      <circle cx="12" cy="12" r="2.2" />
    </svg>
  );
}

export function ProcIcon({ size, color = '#5b8fb9', style }: IconProps) {
  return (
    <svg {...base(size)} stroke={color} style={style}>
      <circle cx="12" cy="12" r="8" />
      <path d="M8 12h8" />
    </svg>
  );
}

export function TriggerIcon({ size, color = '#c08a2e', style }: IconProps) {
  return (
    <svg {...base(size)} stroke={color} style={style}>
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
    </svg>
  );
}

export function SearchIcon({ size = 12, color = '#9aa0a8', style }: IconProps) {
  return (
    <svg {...base(size)} stroke={color} style={style}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </svg>
  );
}

export function PlusIcon({ size = 15, color = '#e5533d', style }: IconProps) {
  return (
    <svg {...base(size)} stroke={color} style={style}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function ChevronIcon({ size = 9, open = false, color = '#9aa0a8' }: IconProps & { open?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke={color}
      strokeWidth={1.6}
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}
    >
      <path d="M4 2l4 4-4 4" />
    </svg>
  );
}

export function PlayIcon({ size = 10, color = '#fff' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <path d="M6 3l16 9-16 9z" />
    </svg>
  );
}

export function EmptyDbIcon({ size = 44 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      <ellipse cx="24" cy="13" rx="14" ry="6" stroke="#d9907f" strokeWidth="2" />
      <path
        d="M10 13v10c0 3.3 6.3 6 14 6s14-2.7 14-6V13"
        stroke="#d9907f"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M10 23v10c0 3.3 6.3 6 14 6s14-2.7 14-6V23"
        stroke="#e6b3a6"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
