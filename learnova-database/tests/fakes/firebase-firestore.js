// Test double for firebase-firestore.js: in-memory documents + transactions + fault injection.
// It does NOT evaluate security rules (that is tests/rules, run against the emulator).
// It records every operation so tests can assert exactly which paths were touched, and it exposes
// an onWrite hook so contract tests can check each write against the rules' field allowlists.

export class FakeTimestamp {
  constructor(ms) { this.ms = ms; }
  toMillis() { return this.ms; }
}
const SERVER_TS = { __sentinel: "serverTimestamp" };

const store = new Map();   // path -> plain data
const log = [];            // { op, path }
let faults = [];           // { kind: 'read'|'write', code }
let writeHook = null;
let readHook = null;

// Deep clone that keeps FakeTimestamp instances (structuredClone would drop their methods,
// unlike the real SDK whose snapshots return real Timestamp objects).
function clone(v) {
  if (v instanceof FakeTimestamp) return new FakeTimestamp(v.ms);
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}
function resolveSentinels(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) out[k] = v === SERVER_TS ? new FakeTimestamp(Date.now()) : clone(v);
  return out;
}
function takeFault(kind) {
  const i = faults.findIndex((f) => f.kind === kind);
  if (i === -1) return;
  const [f] = faults.splice(i, 1);
  throw Object.assign(new Error(`fake ${f.code}`), { code: f.code });
}

export const getFirestore = () => ({ fake: true });
export const serverTimestamp = () => SERVER_TS;
export function doc(_db, ...segments) {
  const path = segments.join("/");
  return { type: "doc", path, id: segments[segments.length - 1] };
}
export function collection(_db, ...segments) {
  return { type: "collection", path: segments.join("/") };
}
const snap = (path) => {
  const data = store.get(path);
  return { id: path.split("/").pop(), exists: () => data !== undefined, data: () => clone(data) };
};
export async function getDoc(ref) {
  if (readHook) readHook(ref.path);
  log.push({ op: "get", path: ref.path });
  takeFault("read");
  return snap(ref.path);
}
export async function getDocs(col) {
  log.push({ op: "list", path: col.path });
  takeFault("read");
  const depth = col.path.split("/").length + 1;
  const docs = [...store.keys()]
    .filter((p) => p.startsWith(col.path + "/") && p.split("/").length === depth)
    .map(snap);
  return { docs, size: docs.length, empty: docs.length === 0 };
}
export async function runTransaction(_db, fn) {
  const pending = [];
  const tx = {
    async get(ref) { takeFault("read"); log.push({ op: "tx.get", path: ref.path }); return snap(ref.path); },
    set(ref, data) { pending.push({ kind: "set", ref, data }); return tx; },
    update(ref, data) { pending.push({ kind: "update", ref, data }); return tx; },
  };
  await fn(tx);
  takeFault("write");
  for (const w of pending) {
    const before = store.get(w.ref.path);
    if (w.kind === "update" && before === undefined) {
      throw Object.assign(new Error("no doc"), { code: "not-found" });
    }
    const ruleOp = before === undefined ? "create" : "update";
    if (writeHook) writeHook({ op: ruleOp, path: w.ref.path, before: before && clone(before), data: w.data });
    log.push({ op: `write:${ruleOp}`, path: w.ref.path });
    store.set(w.ref.path, w.kind === "set" ? resolveSentinels(w.data) : { ...before, ...resolveSentinels(w.data) });
  }
}

// ---- test helpers ----
export { FakeTimestamp as __FakeTimestamp };
export const __seed = (path, data) => store.set(path, clone(data));
export const __peek = (path) => (store.has(path) ? clone(store.get(path)) : undefined);
export const __log = () => [...log];
export const __failNext = (kind, code) => faults.push({ kind, code });
export const __onWrite = (fn) => { writeHook = fn; };
export const __onRead = (fn) => { readHook = fn; };
export const __reset = () => { store.clear(); log.length = 0; faults = []; writeHook = null; readHook = null; };
