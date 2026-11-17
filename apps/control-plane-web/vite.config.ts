import vinext from "vinext";
import { defineConfig, loadEnv } from "vite";

const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(({ mode }) => {
  const { CONTROL_PLANE_API_URL = "http://127.0.0.1:3400" } = loadEnv(mode, ".", "CONTROL_PLANE_");

  return {
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: CONTROL_PLANE_API_URL,
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/api/u, ""),
        },
      },
      ...(isCodexSeatbeltSandbox ? { watch: { useFsEvents: false, usePolling: true } } : {}),
    },
    plugins: [vinext()],
  };
});
