import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    env: {
      VITE_RELEASE_TARGET: 'local',
      VITE_API_URL: 'http://127.0.0.1:8080',
      VITE_SOCKET_URL: 'http://127.0.0.1:8080',
      VITE_DRIVER_TRACKING_URL: 'http://127.0.0.1:8091',
      VITE_FIREBASE_PROJECT_ID: 'demo-sysu-security',
      VITE_FIREBASE_AUTH_DOMAIN: 'demo-sysu-security.firebaseapp.com',
      VITE_FIREBASE_STORAGE_BUCKET: 'demo-sysu-security.appspot.com',
      VITE_AUTH_EMULATOR_URL: 'http://127.0.0.1:9099',
      VITE_FIRESTORE_EMULATOR_HOST: '127.0.0.1:8085',
    },
  },
})
