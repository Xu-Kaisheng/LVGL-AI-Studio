import { ProjectFile } from '../types';

/**
 * 读取「宿主仓库设计稿」——由 vite.config.ts 里的 dev 中间件提供，
 * 目录默认是本工具同级的 lvgl/，即 <host-repo>/tools/lvgl/*.json。
 *
 * 这些接口只存在于 `npm run dev` 的开发服务器；`npm run build` 的静态产物里没有，
 * 调用方需要捕获异常并优雅降级（本模块抛出的是可读错误）。
 */

const LIST_URL = '/api/repo-designs';
const FILE_URL = '/api/repo-design';

export interface RepoDesignEntry {
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

export interface RepoDesignList {
  dir: string;
  files: RepoDesignEntry[];
}

const DEV_ONLY_HINT =
  'Reading host-repository design files requires the dev server (npm run dev); a static build has no such endpoint.';

export const listRepoDesigns = async (): Promise<RepoDesignList> => {
  let res: Response;
  try {
    res = await fetch(LIST_URL, { cache: 'no-store' });
  } catch {
    throw new Error(DEV_ONLY_HINT);
  }
  if (!res.ok) {
    // 构建产物里访问 /api/repo-designs 会掉回 index.html 或 404
    throw new Error(res.status === 404 ? DEV_ONLY_HINT : `Scanning the design directory failed: HTTP ${res.status}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) throw new Error(DEV_ONLY_HINT);

  const data = await res.json();
  if (!data || !Array.isArray(data.files)) throw new Error('Unexpected response from the design directory endpoint.');
  return { dir: typeof data.dir === 'string' ? data.dir : '', files: data.files as RepoDesignEntry[] };
};

export const fetchRepoDesign = async (file: string): Promise<ProjectFile> => {
  const res = await fetch(`${FILE_URL}?file=${encodeURIComponent(file)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load ${file}: HTTP ${res.status}`);

  const data = await res.json();
  if (!data || !Array.isArray(data.screens) || !data.settings) {
    throw new Error(`${file} is not a valid project file (missing screens / settings).`);
  }
  return data as ProjectFile;
};

export const formatDesignSize = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

export const formatDesignTime = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
