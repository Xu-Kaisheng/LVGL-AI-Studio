/// <reference types="vite/client" />

// 本地默认配置（来自项目根目录 .env.local，已被 .gitignore 忽略）
interface ImportMetaEnv {
  // AI 供应商配置
  readonly VITE_AI_PROVIDER?: string;
  readonly VITE_AI_API_KEY?: string;
  readonly VITE_AI_BASE_URL?: string;
  readonly VITE_AI_MODEL?: string;
  readonly VITE_AI_THINKING?: string;
  readonly VITE_AI_MAX_TOKENS?: string;
  // 默认画布 / 工程
  readonly VITE_DEFAULT_PROJECT_NAME?: string;
  readonly VITE_DEFAULT_WIDTH?: string;
  readonly VITE_DEFAULT_HEIGHT?: string;
  readonly VITE_DEFAULT_THEME?: string;
  readonly VITE_DEFAULT_TARGET_DEVICE?: string;
  readonly VITE_DEFAULT_BACKGROUND?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
