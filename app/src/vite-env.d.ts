/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEV_TOOLS?: string;
  readonly VITE_AUTOLOAD_FIXTURE?: string;
  readonly VITE_P0_REPORT_PATH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
