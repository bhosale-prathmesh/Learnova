// database/services/levels-service.js
// Read-only access to published learning content:
//   courses/{courseId}                 (title, published)
//   courses/{courseId}/levels/{levelId} (title, order, content)
//
// - Clients can never write content (Rules deny it); authoring is a trusted server workflow.
// - Content is shared by all users, so its cache scope has no UID. A signed-in session is still
//   required before the cache is consulted (Rules require authentication for content).
// - Cache entries expire by TTL. On a network error there is NO stale fallback: the caller
//   gets a retryable NETWORK error.

import { getFirebaseDb, sdk } from "../firebase/firebase-config.js";
import { requireUid } from "../authentication/session-manager.js";
import { runtimeCache, CACHE_TTL_MS } from "../cache/runtime-cache.js";
import {
  DATA_TYPE,
  getContentKeys,
  normalizeDocId,
  fromBackendCourse,
  fromBackendLevel,
} from "../access-datatype.js";
import { AppError, ERROR_CODE, normalizeError } from "../errors.js";

export async function fetchCourseLevels(courseId) {
  const id = normalizeDocId(courseId, "courseId");
  requireUid(); // content requires a signed-in user

  const scope = { uid: null, typeId: DATA_TYPE.LEVEL_DATA, scope: `course:${id}` };
  const cached = runtimeCache.get(scope);
  if (cached.hit) return cached.value;

  const K = getContentKeys();
  try {
    const db = getFirebaseDb();
    const courseSnap = await sdk.getDoc(sdk.doc(db, K.courses, id));
    if (!courseSnap.exists()) throw new AppError(ERROR_CODE.NOT_FOUND);
    const course = fromBackendCourse(id, courseSnap.data());
    if (!course.published) throw new AppError(ERROR_CODE.NOT_FOUND);

    const levelsSnap = await sdk.getDocs(sdk.collection(db, K.courses, id, K.levels));
    const levels = levelsSnap.docs
      .map((d) => fromBackendLevel(d.id, d.data()))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

    const result = { course: { id: course.id, title: course.title }, levels };
    runtimeCache.set(scope, result, CACHE_TTL_MS.LEVELS);
    return result;
  } catch (err) {
    throw normalizeError(err);
  }
}
