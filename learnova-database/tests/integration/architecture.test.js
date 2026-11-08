// Definition-of-done guards from the revised blueprint, enforced against the SOURCE.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { listDataTypes } from "../../database/access-datatype.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DB = join(ROOT, "database");
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const files = walk(DB);
const rel = (f) => relative(DB, f);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("revised blueprint: definition of done (source checks)", () => {
  it("matches the revised folder structure (+ errors.js as the shared error contract)", () => {
    expect(files.map(rel).sort()).toEqual([
      "access-control.js", "access-datatype.js", "authentication/authentication-manager.js",
      "authentication/session-manager.js", "cache/runtime-cache.js", "confirmation-manager.js",
      "errors.js", "firebase/firebase-config.js", "services/levels-service.js",
      "services/progress-service.js", "services/users-service.js",
    ]);
    expect(existsSync(join(ROOT, "firestore.rules"))).toBe(true);
  });

  it("access-rules.js does not exist and nothing references it", () => {
    expect(existsSync(join(DB, "access-rules.js"))).toBe(false);
    for (const f of files) expect(readFileSync(f, "utf8")).not.toMatch(/access-rules|permission[-_ ]?matrix/i);
  });

  it("no frontend admin/role concept anywhere in the module code", () => {
    for (const f of files) {
      const code = stripComments(readFileSync(f, "utf8"));
      expect(code, rel(f)).not.toMatch(/\badmin\b|\brole\b|role_type|custom ?claims?/i);
    }
  });

  it("backend key literals appear ONLY in access-datatype.js (everything else resolves via the registry)", () => {
    const keys = [...new Set(listDataTypes().map((t) => t.key))];
    for (const f of files.filter((x) => rel(x) !== "access-datatype.js")) {
      const code = stripComments(readFileSync(f, "utf8"));
      for (const k of keys) {
        expect(code, `${rel(f)} hardcodes backend key "${k}"`).not.toMatch(new RegExp(`["'\`]${k}["'\`]`));
      }
    }
  });

  it("no magic numeric data-type IDs: services/gateway never call getBackendKey with a literal", () => {
    for (const f of files) {
      expect(stripComments(readFileSync(f, "utf8")), rel(f)).not.toMatch(/getBackendKey\(\s*\d/);
    }
  });

  it("Firebase SDK is imported ONLY by firebase-config.js; no Admin SDK / service-account material", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (rel(f) !== "firebase/firebase-config.js") expect(src, rel(f)).not.toMatch(/gstatic\.com\/firebasejs|from\s+["']firebase/);
      expect(src, rel(f)).not.toMatch(/firebase-admin|private_key|BEGIN PRIVATE KEY/);
    }
  });

  it("only the gateway imports services; services never import the gateway", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (rel(f) !== "access-control.js") expect(src, rel(f)).not.toMatch(/from\s+["'][^"']*services\/[^"']+["']/);
      if (rel(f).startsWith("services/")) expect(src, rel(f)).not.toMatch(/access-control/);
    }
  });

  it("services take no identity parameter: own-data functions are (patch) or ()", async () => {
    const p = await import("../../database/services/progress-service.js");
    const u = await import("../../database/services/users-service.js");
    expect([p.getProgress.length, p.updateProgress.length]).toEqual([0, 1]);
    expect([u.getProfile.length, u.ensureProfile.length, u.updateProfile.length]).toEqual([0, 0, 1]);
  });

  it("firestore.rules: default deny, no client content writes, no role checks, ownership via auth uid", () => {
    const rules = readFileSync(join(ROOT, "firestore.rules"), "utf8");
    expect(rules).toMatch(/match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/);
    const rulesCode = rules.replace(/\/\/.*$/gm, "");
    expect(rulesCode).not.toMatch(/\brole\b|role_type|request\.auth\.token\.admin/);
    // users + user_progress: read/create/update are each owner-gated; delete is denied outright.
    expect(rulesCode.match(/allow (read|create|update): if isOwner\(uid\)/g)).toHaveLength(6);
    expect(rulesCode.match(/allow delete: if false;/g)).toHaveLength(2);
    const courses = rules.slice(rules.indexOf("match /courses/{courseId}"), rules.indexOf("default deny"));
    expect(courses.match(/allow write: if false;/g)).toHaveLength(2); // courses + levels
    expect(courses).not.toMatch(/allow (create|update|delete)/);
  });
});
