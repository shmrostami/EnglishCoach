import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    // The API is a different origin (127.0.0.1:3100); the browser would block
    // it (CORS). The dev server proxies both the REST API and the session
    // WebSocket to it, so the web client can use same-origin relative URLs.
    proxy: {
      "/v1": { target: "http://127.0.0.1:3100" },
      "/ws": { target: "http://127.0.0.1:3100", ws: true },
    },
  },
});
