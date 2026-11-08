// Test double for firebase-app.js (aliased in vitest.config.js).
const apps = [];
export function initializeApp(options) {
  const app = { name: "[DEFAULT]", options };
  apps.push(app);
  return app;
}
export const getApps = () => [...apps];
export const getApp = () => apps[0];
export const __reset = () => { apps.length = 0; };
