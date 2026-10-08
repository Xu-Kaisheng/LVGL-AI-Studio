import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

/**
 * 可选的本地引导工程（generic）：
 * 从 VITE_BOOTSTRAP_PROJECT 指定的 URL 载入一份工程 JSON 写入本地存储。
 *
 * 生效规则：
 * - 尚未灌入过，或工程 version 变化时 → 自动灌入（覆盖工作区）
 * - 同一 version 再次打开 → 保留你在工具里的改动，不覆盖
 * - URL 带 ?bootstrap  → 忽略以上规则，强制重灌
 *
 * 文件放在 public/ 下且以 .local 结尾（被 .gitignore 的 *.local 忽略）。
 */
const STORAGE_KEY = 'lvgl_studio_autosave_v1';
const BOOTSTRAP_VERSION_KEY = 'lvgl_studio_bootstrap_version';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
const renderApp = () =>
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );

const seedFromBootstrap = async (): Promise<void> => {
  const url = import.meta.env.VITE_BOOTSTRAP_PROJECT;
  if (!url) return;

  const force = new URLSearchParams(location.search).has('bootstrap');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    const project = JSON.parse(raw);
    const version = String(project.version ?? '');

    const applied = localStorage.getItem(BOOTSTRAP_VERSION_KEY);
    if (!force && applied && applied === version) return; // 同一版本：保留用户改动

    localStorage.setItem(STORAGE_KEY, raw);
    localStorage.setItem(BOOTSTRAP_VERSION_KEY, version);
    console.info(`[bootstrap] loaded project (v${version || '?'}) from ${url}`);
  } catch (e) {
    console.warn(`[bootstrap] failed to load ${url}:`, e);
  }
};

seedFromBootstrap().finally(renderApp);
