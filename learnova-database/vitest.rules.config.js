import { defineConfig } from "vitest/config";

// Security-rules tests: real Firestore emulator, real SDK. Run with `npm run test:rules`.
export default defineConfig({
  test: { environment: "node", include: ["tests/rules/**/*.test.js"], testTimeout: 20000 },
});
