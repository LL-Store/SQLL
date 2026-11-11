/**
 * 应用入口：先加载设计令牌与全局样式，再挂载根组件。
 * 这里不写业务逻辑，所有状态都在 store 里。
 */

import './styles/tokens.css';
import './styles/global.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(<App />);
