import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// HTTPS so a phone on the same network can use its microphone (getUserMedia
// needs a secure context). The API is proxied so the player is same-origin.
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/v1": { target: "http://localhost:4100", changeOrigin: true },
      "/media": { target: "http://localhost:4100", changeOrigin: true },
      "/dev": { target: "http://localhost:4100", changeOrigin: true },
      "/health": { target: "http://localhost:4100", changeOrigin: true },
    },
  },
});
