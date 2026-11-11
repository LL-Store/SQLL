/**
 * 顶部标题栏：品牌、版本号、面包屑与设置入口。
 * 版本号来自 `__APP_VERSION__`（webpack 从 package.json 注入），不在代码里写死。
 */

import { APP_VERSION } from '@/types';
import { useAppStore } from '@/store';
import s from './TitleBar.module.css';

export function TitleBar() {
  const openSettings = useAppStore((x) => x.openSettings);
  return (
    <header className={s.bar}>
      <div className={s.brand}>
        <span className={s.mark}>S</span>
        <span className={s.name}>SQLL</span>
        <span className={s.version} title="版本号来自 package.json 的 version 字段">
          v{APP_VERSION}
        </span>
      </div>
      <div className={s.crumb}>未连接</div>
      <div className={s.right}>
        <button className={s.settings} onClick={openSettings} title="设置">
          ⚙ 设置
        </button>
      </div>
    </header>
  );
}
