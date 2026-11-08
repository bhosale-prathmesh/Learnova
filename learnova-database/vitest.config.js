import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const fake = (name) => fileURLToPath(new URL(`./tests/fakes/${name}.js`, import.meta.url));

// The module imports the Firebase SDK from pinned CDN URLs. In tests those URLs resolve to in-memory fakes.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^https:\/\/www\.gstatic\.com\/firebasejs\/[^/]+\/firebase-app\.js$/, replacement: fake("firebase-app") },
      { find: /^https:\/\/www\.gstatic\.com\/firebasejs\/[^/]+\/firebase-auth\.js$/, replacement: fake("firebase-auth") },
      { find: /^https:\/\/www\.gstatic\.com\/firebasejs\/[^/]+\/firebase-firestore\.js$/, replacement: fake("firebase-firestore") },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.js", "tests/integration/**/*.test.js"],
  },
});
