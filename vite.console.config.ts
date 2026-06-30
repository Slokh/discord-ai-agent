import react from "@vitejs/plugin-react";
import regen from "regen-ui/vite";
import { defineConfig } from "vite";

const apiTarget = process.env.CONSOLE_API_TARGET || "http://localhost:8080";
const apiAuthHeader = process.env.CONSOLE_API_AUTH_PASSWORD
  ? `Basic ${Buffer.from(`admin:${process.env.CONSOLE_API_AUTH_PASSWORD}`).toString("base64")}`
  : process.env.CONSOLE_API_AUTH_HEADER;
const apiProxy = {
  target: apiTarget,
  changeOrigin: true,
  headers: apiAuthHeader ? { Authorization: apiAuthHeader } : undefined
};

export default defineConfig({
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
});
