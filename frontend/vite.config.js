import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// TrustTier DApp.
//  - dev: proxies /api to the FastAPI router (off-chain/main.py), so the app
//    finds a local router without any CORS setup.
//  - build: VITE_BASE sets the public path (the GitHub Pages workflow uses
//    /<repo>/). The evaluation results under ../off-chain are imported at
//    build time, so re-running an evaluation and pushing updates the site.
export default defineConfig({
  base: process.env.VITE_BASE || "/",
  plugins: [react()],
  server: {
    port: 5173,
    fs: { allow: [".."] },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
