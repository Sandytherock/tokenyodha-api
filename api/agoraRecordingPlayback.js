const crypto = require("crypto");
const { Storage } = require("@google-cloud/storage");
const {
  getAdminDb,
  json,
  requireAuthenticatedUser,
  setCors,
} = require("./_agoraCloudRecording");

function normalizeValue(value) {
  return String(value || "").trim();
}

function getGcsClient() {
  return new Storage({
    projectId: normalizeValue(process.env.FIREBASE_PROJECT_ID),
    credentials: {
      client_email: normalizeValue(process.env.FIREBASE_CLIENT_EMAIL),
      private_key: normalizeValue(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, "\n"),
    },
  });
}

async function getObjectVerification(bucketName, objectKey) {
  const file = getGcsClient().bucket(bucketName).file(objectKey);
  const [exists] = await file.exists();

  if (!exists) {
    const error = new Error("Recording file not found in storage");
    error.statusCode = 404;
    throw error;
  }

  const [metadata] = await file.getMetadata();
  return {
    contentType: normalizeValue(metadata?.contentType) || null,
    size: normalizeValue(metadata?.size) || null,
    updated: normalizeValue(metadata?.updated) || null,
    generation: normalizeValue(metadata?.generation) || null,
  };
}

function pickRecordingObjectKey(classData) {
  const direct = normalizeValue(classData.recordingObjectKey);
  const files = Array.isArray(classData.recordingFiles) ? classData.recordingFiles : [];
  const mp4File = files.find((item) =>
    normalizeValue(item?.fileName || item?.filename).toLowerCase().endsWith(".mp4")
  );
  const hlsFile = files.find((item) =>
    normalizeValue(item?.fileName || item?.filename).toLowerCase().endsWith(".m3u8")
  );

  if (direct.toLowerCase().endsWith(".mp4")) return direct;
  if (mp4File) return normalizeValue(mp4File?.fileName || mp4File?.filename);
  if (direct) return direct;
  if (hlsFile) return normalizeValue(hlsFile?.fileName || hlsFile?.filename);

  const fallback = files[0];
  return normalizeValue(fallback?.fileName || fallback?.filename);
}

function inferContentType(objectKey, verification) {
  const verifiedType = normalizeValue(verification?.contentType).toLowerCase();
  if (verifiedType) return verifiedType;

  const normalizedKey = normalizeValue(objectKey).toLowerCase();
  if (normalizedKey.endsWith(".mp4")) return "video/mp4";
  if (normalizedKey.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  return "application/octet-stream";
}

async function ensureFirebaseDownloadToken(bucketName, objectKey) {
  const file = getGcsClient().bucket(bucketName).file(objectKey);
  const [metadata] = await file.getMetadata();
  const customMetadata = metadata?.metadata || {};
  const existingTokens = normalizeValue(customMetadata.firebaseStorageDownloadTokens);

  if (existingTokens) {
    return existingTokens.split(",").map((item) => normalizeValue(item)).filter(Boolean)[0] || null;
  }

  const nextToken = crypto.randomUUID();
  await file.setMetadata({
    metadata: {
      ...customMetadata,
      firebaseStorageDownloadTokens: nextToken,
    },
  });

  return nextToken;
}

function buildFirebaseDownloadUrl(bucketName, objectKey, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(
    bucketName
  )}/o/${encodeURIComponent(objectKey)}?alt=media&token=${encodeURIComponent(token)}`;
}

function userHasAccess(userData, classData, uid) {
  if (normalizeValue(classData.teacherId) === normalizeValue(uid)) return true;
  if (!classData.isPaid && !normalizeValue(classData.planId)) return true;

  const planId = normalizeValue(classData.planId);
  const courseId = normalizeValue(classData.courseId);
  const subscriptions = Array.isArray(userData?.subscriptions) ? userData.subscriptions : [];

  return subscriptions.some((sub) => {
    if (!sub || typeof sub !== "object") return false;
    return normalizeValue(sub.planId) === planId && normalizeValue(sub.courseId) === courseId;
  });
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    const user = await requireAuthenticatedUser(req);
    const { classId } = req.body || {};
    if (!classId) {
      json(res, 400, { ok: false, error: "classId required" });
      return;
    }

    const db = getAdminDb();
    const [classSnap, userSnap] = await Promise.all([
      db.collection("liveClasses").doc(classId).get(),
      db.collection("users").doc(user.uid).get(),
    ]);

    if (!classSnap.exists) {
      json(res, 404, { ok: false, error: "Live class not found" });
      return;
    }

    const classData = classSnap.data() || {};
    const userData = userSnap.exists ? userSnap.data() || {} : {};

    if (!userHasAccess(userData, classData, user.uid)) {
      json(res, 403, { ok: false, error: "Access denied" });
      return;
    }

    const bucket = process.env.AGORA_RECORDING_BUCKET;
    const objectKey = pickRecordingObjectKey(classData);
    if (!bucket || !objectKey) {
      json(res, 404, { ok: false, error: "Recording file not ready" });
      return;
    }

    const verification = await getObjectVerification(bucket, objectKey);
    const responseType = inferContentType(objectKey, verification);
    const downloadToken = await ensureFirebaseDownloadToken(bucket, objectKey);
    const signedUrl = buildFirebaseDownloadUrl(bucket, objectKey, downloadToken);
    const expiresIn = Number(process.env.RECORDING_SIGNED_URL_TTL_SECONDS || 900);

    json(res, 200, {
      ok: true,
      signedUrl,
      objectKey,
      expiresIn,
      verification,
      responseType,
      delivery: "firebaseDownloadToken",
    });
  } catch (error) {
    console.error("agoraRecordingPlayback", error);
    json(res, error.statusCode || 500, {
      ok: false,
      error: error.message || "Internal error",
    });
  }
};
