/// <reference types="vite/client" />

// F20-OBD 本地 AI 配置（来自项目根目录 .env.local，已被 .gitignore 忽略）
interface ImportMetaEnv {
  readonly VITE_F20_AI_PROVIDER?: string;
  readonly VITE_F20_AI_API_KEY?: string;
  readonly VITE_F20_AI_BASE_URL?: string;
  readonly VITE_F20_AI_MODEL?: string;
  readonly VITE_F20_AI_THINKING?: string;
  readonly VITE_F20_AI_MAX_TOKENS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
