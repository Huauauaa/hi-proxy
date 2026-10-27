import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const proxyTarget = process.env.HI_PROXY_ORIGIN ?? "http://localhost:3010";

// 把 /v1 与 /__proxy 反代到本地 hi-proxy 网关，页面同源调用，无跨域问题
const proxy = {
  "/v1": { target: proxyTarget, changeOrigin: true },
  "/__proxy": { target: proxyTarget, changeOrigin: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy, port: 5173 },
  preview: { proxy, port: 4173 },
});
