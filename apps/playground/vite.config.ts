import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// Plain HTTP by default: http://localhost is a secure context, so the mic works
// on this machine with no certificate warning. Set PLAYGROUND_HTTPS=1 when a
// phone on the network needs to connect (getUserMedia needs HTTPS off-localhost).
const https = process.env.PLAYGROUND_HTTPS === "1";
export default defineConfig({
  plugins: https ? [react(), basicSsl()] : [react()],
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
