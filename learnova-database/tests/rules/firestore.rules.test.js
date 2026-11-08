// Firestore Security Rules tests - run against the real Firestore EMULATOR.
//   npm run test:rules      (needs Java 11+; first run downloads the emulator)
//
// These exercise the actual rules, independent of the frontend gateway (i.e. they prove the rules hold
// even if the gateway is bypassed). Blueprint scenarios A-F are tagged in the test names.

import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, serverTimestamp, Timestamp,
} from "firebase/firestore";

let env;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "learnova-rules-test",
    firestore: { rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8") },
  });
});
afterAll(async () => { await env?.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const as = (uid, token = {}) => env.authenticatedContext(uid, token).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const seed = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.firestore()));
const T = () => serverTimestamp();
const OLD = () => Timestamp.fromMillis(1_000);
const without = (o, k) => { const c = { ...o }; delete c[k]; return c; };

const profile = (o = {}) => ({ uid: "u1", display_name: "Alex", created_at: T(), updated_at: T(), ...o });
const progress = (o = {}) => ({ user_id: "u1", levels_passed: [1], total_score: 10, streak_count: 1, updated_at: T(), ...o });
const seedProfile = (o = {}) => seed((db) => setDoc(doc(db, "users/u1"), { uid: "u1", display_name: "Alex", created_at: OLD(), updated_at: OLD(), ...o }));
const seedProgress = (o = {}) => seed((db) => setDoc(doc(db, "user_progress/u1"), { user_id: "u1", levels_passed: [1, 2], total_score: 10, streak_count: 4, updated_at: OLD(), ...o }));

describe("users/{uid}", () => {
  it("F: unauthenticated cannot read or write", async () => {
    await seedProfile();
    await assertFails(getDoc(doc(anon(), "users/u1")));
    await assertFails(setDoc(doc(anon(), "users/u1"), profile()));
  });

  it("owner can create a valid profile (with and without email)", async () => {
    await assertSucceeds(setDoc(doc(as("u1", { email: "a@x.com" }), "users/u1"), profile({ email_id: "a@x.com" })));
    await env.clearFirestore();
    await assertSucceeds(setDoc(doc(as("u1"), "users/u1"), profile()));
  });

  it.each([
    ["someone else's path", "u2", () => profile()],
    ["uid field mismatch", "u1", () => profile({ uid: "u2" })],
    ["C: role field injected", "u1", () => profile({ role_type: "admin" })],
    ["C: role field named role", "u1", () => profile({ role: "admin" })],
    ["unexpected field", "u1", () => profile({ is_premium: true })],
    ["missing display_name", "u1", () => without(profile(), "display_name")],
    ["empty display_name", "u1", () => profile({ display_name: "" })],
    ["display_name too long", "u1", () => profile({ display_name: "x".repeat(81) })],
    ["display_name wrong type", "u1", () => profile({ display_name: 5 })],
    ["client-supplied created_at", "u1", () => profile({ created_at: Timestamp.now() })],
    ["client-supplied updated_at", "u1", () => profile({ updated_at: Timestamp.now() })],
  ])("create denied: %s", async (_n, path, build) => {
    await assertFails(setDoc(doc(as("u1", { email: "a@x.com" }), `users/${path}`), build()));
  });

  it("create denied: email that is not the authenticated email", async () => {
    await assertFails(setDoc(doc(as("u1", { email: "a@x.com" }), "users/u1"), profile({ email_id: "evil@x.com" })));
    await assertFails(setDoc(doc(as("u1"), "users/u1"), profile({ email_id: "a@x.com" }))); // token has no email
  });

  it("owner reads own profile; other user cannot", async () => {
    await seedProfile();
    await assertSucceeds(getDoc(doc(as("u1"), "users/u1")));
    await assertFails(getDoc(doc(as("u2"), "users/u1")));
  });

  it("owner can change display_name (with server timestamp)", async () => {
    await seedProfile();
    await assertSucceeds(updateDoc(doc(as("u1"), "users/u1"), { display_name: "New", updated_at: T() }));
  });

  it.each([
    ["uid", { uid: "u2" }],
    ["email_id", { email_id: "evil@x.com" }],
    ["created_at", { created_at: T() }],
    ["C: add role_type", { role_type: "admin" }],
    ["unexpected field", { badge: "gold" }],
    ["display_name invalid", { display_name: "" }],
  ])("update denied: %s", async (_n, patch) => {
    await seedProfile();
    await assertFails(updateDoc(doc(as("u1", { email: "a@x.com" }), "users/u1"), { ...patch, updated_at: T() }));
  });

  it("update denied: without server timestamp / by another user", async () => {
    await seedProfile();
    await assertFails(updateDoc(doc(as("u1"), "users/u1"), { display_name: "New" }));
    await assertFails(updateDoc(doc(as("u2"), "users/u1"), { display_name: "Hacked", updated_at: T() }));
  });

  it("server-managed fields on an existing doc stay immutable but do not block name changes", async () => {
    await seedProfile({ role_type: "student" });
    await assertSucceeds(updateDoc(doc(as("u1"), "users/u1"), { display_name: "New", updated_at: T() }));
    await assertFails(updateDoc(doc(as("u1"), "users/u1"), { role_type: "admin", updated_at: T() }));
  });

  it("delete denied", async () => {
    await seedProfile();
    await assertFails(deleteDoc(doc(as("u1"), "users/u1")));
  });
});

describe("user_progress/{uid}", () => {
  it("F: unauthenticated denied", async () => {
    await seedProgress();
    await assertFails(getDoc(doc(anon(), "user_progress/u1")));
    await assertFails(setDoc(doc(anon(), "user_progress/u1"), progress()));
  });

  it("A: user reads own progress", async () => {
    await seedProgress();
    await assertSucceeds(getDoc(doc(as("u1"), "user_progress/u1")));
  });

  it("B: user cannot read or write another UID's progress (gateway bypassed)", async () => {
    await seedProgress();
    await assertFails(getDoc(doc(as("u2"), "user_progress/u1")));
    await assertFails(setDoc(doc(as("u2"), "user_progress/u1"), progress({ user_id: "u2" })));
    await assertFails(updateDoc(doc(as("u2"), "user_progress/u1"), { total_score: 999, updated_at: T() }));
    await assertFails(setDoc(doc(as("u2"), "user_progress/u1"), progress({ user_id: "u1" })));
  });

  it("owner can create a valid progress document", async () => {
    await assertSucceeds(setDoc(doc(as("u1"), "user_progress/u1"), progress()));
  });

  it.each([
    ["D: negative score", { total_score: -1 }],
    ["D: float score", { total_score: 1.5 }],
    ["D: string score", { total_score: "100" }],
    ["D: score over cap", { total_score: 10_000_001 }],
    ["D: negative streak", { streak_count: -1 }],
    ["D: streak wrong type", { streak_count: "3" }],
    ["D: levels not a list", { levels_passed: "1,2" }],
    ["D: too many levels", { levels_passed: Array.from({ length: 501 }, (_, i) => i) }],
    ["C: user_id of someone else", { user_id: "u2" }],
    ["C: role/admin field", { role: "admin" }],
    ["C: extra field", { bonus: 1 }],
    ["client-supplied updated_at", { updated_at: Timestamp.now() }],
  ])("create denied: %s", async (_n, override) => {
    await assertFails(setDoc(doc(as("u1"), "user_progress/u1"), progress(override)));
  });

  it("create denied: missing required field", async () => {
    await assertFails(setDoc(doc(as("u1"), "user_progress/u1"), without(progress(), "total_score")));
  });

  it("update allowed: score up, level added, streak reset", async () => {
    await seedProgress();
    const ref = doc(as("u1"), "user_progress/u1");
    await assertSucceeds(updateDoc(ref, { total_score: 50, updated_at: T() }));
    await assertSucceeds(updateDoc(ref, { levels_passed: [1, 2, 3], updated_at: T() }));
    await assertSucceeds(updateDoc(ref, { streak_count: 0, updated_at: T() }));
  });

  it.each([
    ["score decreases", { total_score: 5 }],
    ["a completed level is removed", { levels_passed: [1] }],
    ["user_id changed", { user_id: "u2" }],
    ["unexpected field added", { role: "admin" }],
    ["score wrong type", { total_score: "11" }],
    ["negative streak", { streak_count: -1 }],
  ])("update denied: %s", async (_n, patch) => {
    await seedProgress();
    await assertFails(updateDoc(doc(as("u1"), "user_progress/u1"), { ...patch, updated_at: T() }));
  });

  it("update denied without a server timestamp", async () => {
    await seedProgress();
    await assertFails(updateDoc(doc(as("u1"), "user_progress/u1"), { total_score: 50 }));
  });

  it("delete denied", async () => {
    await seedProgress();
    await assertFails(deleteDoc(doc(as("u1"), "user_progress/u1")));
  });
});

describe("courses and levels (published content)", () => {
  const seedCourse = (published) => seed(async (db) => {
    await setDoc(doc(db, "courses/py"), { title: "Python", published });
    await setDoc(doc(db, "courses/py/levels/l1"), { title: "Intro", order: 1, content: {} });
  });

  it("signed-in user can read a published course and its levels", async () => {
    await seedCourse(true);
    await assertSucceeds(getDoc(doc(as("u1"), "courses/py")));
    await assertSucceeds(getDocs(collection(as("u1"), "courses/py/levels")));
  });

  it("F: unauthenticated cannot read content", async () => {
    await seedCourse(true);
    await assertFails(getDoc(doc(anon(), "courses/py")));
    await assertFails(getDocs(collection(anon(), "courses/py/levels")));
  });

  it("unpublished course and its levels are not readable", async () => {
    await seedCourse(false);
    await assertFails(getDoc(doc(as("u1"), "courses/py")));
    await assertFails(getDocs(collection(as("u1"), "courses/py/levels")));
  });

  it("reading a course that does not exist returns 'not found' (no rules error)", async () => {
    await assertSucceeds(getDoc(doc(as("u1"), "courses/missing")));
  });

  it("E: client cannot create, update or delete courses or levels", async () => {
    await seedCourse(true);
    const db = as("u1");
    await assertFails(setDoc(doc(db, "courses/new"), { title: "x", published: true }));
    await assertFails(updateDoc(doc(db, "courses/py"), { title: "hacked" }));
    await assertFails(deleteDoc(doc(db, "courses/py")));
    await assertFails(setDoc(doc(db, "courses/py/levels/l9"), { title: "x", order: 9 }));
    await assertFails(updateDoc(doc(db, "courses/py/levels/l1"), { title: "hacked" }));
    await assertFails(deleteDoc(doc(db, "courses/py/levels/l1")));
  });
});

describe("default deny", () => {
  it("any unmatched path is denied, even for signed-in users", async () => {
    const db = as("u1");
    await assertFails(getDoc(doc(db, "anything/x")));
    await assertFails(setDoc(doc(db, "anything/x"), { a: 1 }));
    await assertFails(setDoc(doc(db, "roles/u1"), { role: "admin" }));
    await assertFails(setDoc(doc(db, "users/u1/private/x"), { a: 1 }));
  });
});
