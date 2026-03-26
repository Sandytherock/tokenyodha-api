const admin = require("firebase-admin");
const { RtcTokenBuilder, RtcRole } = require("agora-token");

function getEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function json(res, status, payload) {
  res.status(status).json(payload);
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function parseAllowedTeacherEmails() {
  return getEnv("ALLOWED_TEACHER_EMAILS")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function initializeFirebaseAdmin() {
  if (admin.apps.length) return admin.app();

  const projectId = String(getEnv("FIREBASE_PROJECT_ID")).trim();
  const clientEmail = String(getEnv("FIREBASE_CLIENT_EMAIL")).trim();
  const privateKey = String(getEnv("FIREBASE_PRIVATE_KEY")).trim().replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing Firebase Admin credentials");
  }

  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
}

function getAdminDb() {
  initializeFirebaseAdmin();
  return admin.firestore();
}

async function requireAuthenticatedUser(req) {
  initializeFirebaseAdmin();

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    throw new Error("Missing Firebase bearer token");
  }

  const idToken = authHeader.slice("Bearer ".length).trim();
  return admin.auth().verifyIdToken(idToken);
}

async function requireTeacher(req) {
  const decoded = await requireAuthenticatedUser(req);

  const allowedEmails = parseAllowedTeacherEmails();
  const email = String(decoded.email || "").trim().toLowerCase();
  if (allowedEmails.length > 0 && !allowedEmails.includes(email)) {
    const err = new Error("Teacher access denied");
    err.statusCode = 403;
    throw err;
  }

  return decoded;
}

function agoraBasicAuthHeader() {
  const customerId = String(getEnv("AGORA_CUSTOMER_ID")).trim();
  const customerSecret = String(getEnv("AGORA_CUSTOMER_SECRET")).trim();

  if (!customerId || !customerSecret) {
    throw new Error("Missing AGORA_CUSTOMER_ID / AGORA_CUSTOMER_SECRET");
  }

  const token = Buffer.from(`${customerId}:${customerSecret}`).toString("base64");
  return `Basic ${token}`;
}

function buildRecorderToken({ channelName, uid }) {
  const appId = String(getEnv("AGORA_APP_ID")).trim();
  const appCertificate = String(getEnv("AGORA_APP_CERTIFICATE")).trim();
  if (!appId || !appCertificate) {
    throw new Error("Missing AGORA_APP_ID / AGORA_APP_CERTIFICATE");
  }

  const expireSeconds = Number(getEnv("AGORA_TOKEN_EXPIRY_SECONDS", "7200"));
  const privilegeExpireTs = Math.floor(Date.now() / 1000) + expireSeconds;
  return RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channelName,
    Number(uid),
    RtcRole.SUBSCRIBER,
    privilegeExpireTs
  );
}

function getStorageConfig() {
  const vendor = Number(getEnv("AGORA_RECORDING_STORAGE_VENDOR", "1"));
  const region = Number(getEnv("AGORA_RECORDING_STORAGE_REGION", "0"));
  const bucket = String(getEnv("AGORA_RECORDING_BUCKET")).trim();
  const accessKey = String(getEnv("AGORA_RECORDING_ACCESS_KEY")).trim();
  const secretKey = String(getEnv("AGORA_RECORDING_SECRET_KEY")).trim();
  const basePrefix = String(getEnv("AGORA_RECORDING_FILE_PREFIX", "testyodha")).trim();

  if (!bucket || !accessKey || !secretKey) {
    throw new Error("Missing recording storage credentials");
  }

  return {
    vendor,
    region,
    bucket,
    accessKey,
    secretKey,
    basePrefix,
  };
}

function buildRequestBase({ channelName, recorderUid }) {
  return {
    cname: channelName,
    uid: String(recorderUid),
  };
}

function normalizePrefix(prefixParts) {
  return prefixParts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .map((part) => part.replace(/^\/+|\/+$/g, ""));
}

async function callAgoraCloudRecording(pathname, payload) {
  const appId = String(getEnv("AGORA_APP_ID")).trim();
  if (!appId) throw new Error("Missing AGORA_APP_ID");

  const response = await fetch(`https://api.agora.io/v1/apps/${appId}${pathname}`, {
    method: "POST",
    headers: {
      Authorization: agoraBasicAuthHeader(),
      "Content-Type": "application/json;charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    data = { raw: text };
  }

  if (!response.ok) {
    const err = new Error(data?.message || data?.raw || `Agora API failed (${response.status})`);
    err.statusCode = response.status;
    err.details = data;
    throw err;
  }

  return data;
}

async function getAgoraCloudRecording(pathname) {
  const appId = String(getEnv("AGORA_APP_ID")).trim();
  if (!appId) throw new Error("Missing AGORA_APP_ID");

  const response = await fetch(`https://api.agora.io/v1/apps/${appId}${pathname}`, {
    method: "GET",
    headers: {
      Authorization: agoraBasicAuthHeader(),
    },
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    data = { raw: text };
  }

  if (!response.ok) {
    const err = new Error(data?.message || data?.raw || `Agora API failed (${response.status})`);
    err.statusCode = response.status;
    err.details = data;
    throw err;
  }

  return data;
}

async function acquireResource({ channelName, recorderUid }) {
  return callAgoraCloudRecording("/cloud_recording/acquire", {
    ...buildRequestBase({ channelName, recorderUid }),
    clientRequest: {
      resourceExpiredHour: Number(getEnv("AGORA_RECORDING_RESOURCE_EXPIRE_HOURS", "24")),
      scene: 0,
    },
  });
}

async function startCompositeRecording({
  resourceId,
  channelName,
  recorderUid,
  teacherRtcUid,
  courseId,
  classId,
}) {
  const storage = getStorageConfig();
  const streamUid = String(teacherRtcUid);
  const token = buildRecorderToken({ channelName, uid: recorderUid });

  return callAgoraCloudRecording(
    `/cloud_recording/resourceid/${resourceId}/mode/mix/start`,
    {
      ...buildRequestBase({ channelName, recorderUid }),
      clientRequest: {
        token,
        recordingConfig: {
          maxIdleTime: Number(getEnv("AGORA_RECORDING_MAX_IDLE_SECONDS", "30")),
          streamTypes: 2,
          channelType: 1,
          subscribeAudioUids: [streamUid],
          subscribeVideoUids: [streamUid],
          subscribeUidGroup: 0,
          transcodingConfig: {
            width: Number(getEnv("AGORA_RECORDING_WIDTH", "1280")),
            height: Number(getEnv("AGORA_RECORDING_HEIGHT", "720")),
            fps: Number(getEnv("AGORA_RECORDING_FPS", "15")),
            bitrate: Number(getEnv("AGORA_RECORDING_BITRATE", "1200")),
            mixedVideoLayout: 1,
            backgroundColor: "#000000",
          },
        },
        recordingFileConfig: {
          avFileType: ["hls", "mp4"],
        },
        storageConfig: {
          vendor: storage.vendor,
          region: storage.region,
          bucket: storage.bucket,
          accessKey: storage.accessKey,
          secretKey: storage.secretKey,
          fileNamePrefix: normalizePrefix([storage.basePrefix, courseId, classId]),
        },
      },
    }
  );
}

async function stopCompositeRecording({ resourceId, sid, channelName, recorderUid }) {
  return callAgoraCloudRecording(
    `/cloud_recording/resourceid/${resourceId}/sid/${sid}/mode/mix/stop`,
    {
      ...buildRequestBase({ channelName, recorderUid }),
      clientRequest: {},
    }
  );
}

async function queryCompositeRecording({ resourceId, sid, channelName, recorderUid }) {
  return getAgoraCloudRecording(
    `/cloud_recording/resourceid/${resourceId}/sid/${sid}/mode/mix/query?cname=${encodeURIComponent(
      channelName
    )}&uid=${encodeURIComponent(String(recorderUid))}`
  );
}

module.exports = {
  acquireResource,
  buildRecorderToken,
  getAdminDb,
  json,
  parseAllowedTeacherEmails,
  queryCompositeRecording,
  requireAuthenticatedUser,
  requireTeacher,
  setCors,
  startCompositeRecording,
  stopCompositeRecording,
};
