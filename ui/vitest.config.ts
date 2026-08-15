import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({ root: here, plugins: [react()],
  test: { environment: "jsdom", include: ["src/**/*.test.tsx"] } });
