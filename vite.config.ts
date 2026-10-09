import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 宿主仓库的设计稿目录：默认是本工具所在目录的同级 lvgl/（即 <host-repo>/tools/lvgl/），
 * 可用环境变量 LVGL_STUDIO_DESIGN_DIR 指向别处（相对本目录或绝对路径均可）。
 *
 * 本工具是独立仓库，不假设宿主项目叫什么名字；目录不存在时接口返回空列表，
 * 前端提示「没有工程文件」而不是报错。
 */
const CONFIG_DIR = (() => {
  try {
    return fileURLToPath(new URL('.', import.meta.url));
  } catch {
    return process.cwd();
  }
})();
const DESIGN_DIR = path.resolve(CONFIG_DIR, process.env.LVGL_STUDIO_DESIGN_DIR || '../lvgl');

interface DesignEntry {
  file: string;
  size: number;
  mtime: number;
  projectName?: string;
  width?: number;
  height?: number;
  screens?: number;
  version?: string;
  parseError?: string;
}

const sendJson = (res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (b?: string) => void }, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

const readDesignEntries = (): DesignEntry[] => {
  if (!fs.existsSync(DESIGN_DIR)) return [];
  return fs
    .readdirSync(DESIGN_DIR)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .map((name) => {
      const full = path.join(DESIGN_DIR, name);
      const stat = fs.statSync(full);
      const entry: DesignEntry = { file: name, size: stat.size, mtime: stat.mtimeMs };
      // 顺带把工程摘要读出来，前端列表就不用为一个文件发两次请求
      try {
        const project = JSON.parse(fs.readFileSync(full, 'utf8'));
        entry.projectName = project?.settings?.projectName;
        entry.width = project?.settings?.width;
        entry.height = project?.settings?.height;
        entry.screens = Array.isArray(project?.screens) ? project.screens.length : undefined;
        entry.version = project?.version;
      } catch (err) {
        entry.parseError = (err as Error).message;
      }
      return entry;
    })
    .sort((a, b) => b.mtime - a.mtime); // 最近改动的排前面
};

/**
 * 开发服务器专属接口（apply: 'serve'，构建产物里不存在，前端会优雅降级）：
 * - GET /api/repo-designs             → 列出 tools/lvgl/ 下的 *.json 及摘要
 * - GET /api/repo-design?file=x.json  → 返回该工程的原始 JSON
 */
const repoDesignPlugin = (): Plugin => ({
  name: 'repo-design-projects',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (url.pathname === '/api/repo-designs') {
        try {
          sendJson(res, 200, { dir: DESIGN_DIR, files: readDesignEntries() });
        } catch (err) {
          sendJson(res, 500, { error: (err as Error).message });
        }
        return;
      }

      if (url.pathname === '/api/repo-design') {
        const file = url.searchParams.get('file') ?? '';
        const target = path.resolve(DESIGN_DIR, file);
        // 只放行 DESIGN_DIR 直属的 *.json，挡掉 ../ 之类的路径穿越
        const allowed =
          file.toLowerCase().endsWith('.json') &&
          path.dirname(target) === DESIGN_DIR &&
          fs.existsSync(target);
        if (!allowed) {
          sendJson(res, 404, { error: `design file not found: ${file}` });
          return;
        }
        try {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(fs.readFileSync(target, 'utf8'));
        } catch (err) {
          sendJson(res, 500, { error: (err as Error).message });
        }
        return;
      }

      next();
    });
  }
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, (process as any).cwd(), '');
  return {
    plugins: [react(), repoDesignPlugin()],
    optimizeDeps: {
      // fsevents 是 vite/rollup 的 macOS 可选原生依赖（.node 文件），
      // 被预打包扫描到时会报 "No loader is configured for .node files" 并让整个
      // 依赖预构建失败（页面里 react / lucide 等 dep 会 504）。它只在 Node 侧用，
      // 浏览器端永远不需要，直接排除。
      exclude: ['fsevents']
    },
    define: {
      'process.env.API_KEY': JSON.stringify(env.API_KEY)
    }
  };
});
