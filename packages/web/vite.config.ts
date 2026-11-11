import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Point the UI at a different server, for testing against a scratch database.
const API = process.env.JOBSEARCH_API ?? "http://127.0.0.1:5179";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    proxy: {
      "/api": {
        target: API,
        changeOrigin: true,
      },
    },
  },
});
