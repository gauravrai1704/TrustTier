import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// TrustTier dashboard dev server. Proxies /api to the FastAPI router
// (off-chain/main.py) so the frontend never needs CORS configuration to
// match a hardcoded backend origin - see off-chain/main.py's CORS
// middleware for the corresponding backend-side setup.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
