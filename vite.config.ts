import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_PORT = Number(process.env.API_PORT ?? 8787);

export default defineConfig({
  plugins: [react()],
  // .env.local의 비밀 값이 번들에 들어가지 않도록 VITE_ 접두사 변수만 노출한다 (기본값 유지).
  envPrefix: "VITE_",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${API_PORT}` },
  },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
} as any);
