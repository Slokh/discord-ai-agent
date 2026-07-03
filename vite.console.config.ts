import react from "@vitejs/plugin-react";
import regen from "regen-ui/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.CONSOLE_API_TARGET || env.CONTROL_UI_PUBLIC_URL || "http://localhost:8080";
  const apiAuthHeader = env.CONSOLE_API_AUTH_PASSWORD
    ? `Basic ${Buffer.from(`admin:${env.CONSOLE_API_AUTH_PASSWORD}`).toString("base64")}`
    : env.CONSOLE_API_AUTH_HEADER;
  const apiProxy = {
    target: apiTarget,
    changeOrigin: true,
    headers: apiAuthHeader ? { Authorization: apiAuthHeader } : undefined
  };

  return {
    root: "src/control/console",
    base: "/console/",
    plugins: [regen({ theme: "isolated" }), react()],
    optimizeDeps: {
      include: ["eventemitter3", "ox", "use-sync-external-store/shim", "use-sync-external-store/shim/with-selector"]
    },
    server: {
      port: 5174,
      strictPort: false,
      proxy: {
        "/api": apiProxy,
        "/logout": apiProxy
      }
    },
    build: {
      outDir: "../../../dist/console",
      emptyOutDir: true
    }
  };
});
