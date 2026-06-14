import { defineConfig } from "vite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        dashboard: resolve(__dirname, "dashboard.html"),
        qrGenerator: resolve(__dirname, "qr-generator.html"),
      },
    },
  },
  optimizeDeps: {
    include: ["socket.io-client"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "https://sysu-app-production.up.railway.app",
        changeOrigin: true,
        secure: true,
      },
      "/socket.io": {
        target: "https://sysu-go-production.up.railway.app",
        changeOrigin: true,
        secure: true,
        ws: true,
      },
    },
  },
});