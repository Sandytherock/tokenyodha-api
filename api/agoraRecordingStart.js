const {
  acquireResource,
  json,
  requireTeacher,
  setCors,
  startCompositeRecording,
} = require("./_agoraCloudRecording");

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
    const teacher = await requireTeacher(req);
    const { classId, courseId, channelName, teacherRtcUid, recorderUid } = req.body || {};

    if (!classId || !courseId || !channelName || teacherRtcUid == null) {
      json(res, 400, { error: "classId, courseId, channelName, teacherRtcUid required" });
      return;
    }

    const cloudRecorderUid = Number(recorderUid || process.env.AGORA_RECORDING_UID || 999999);
    const acquireResult = await acquireResource({
      channelName,
      recorderUid: cloudRecorderUid,
    });

    const startResult = await startCompositeRecording({
      resourceId: acquireResult.resourceId,
      channelName,
      recorderUid: cloudRecorderUid,
      teacherRtcUid,
      courseId,
      classId,
    });

    json(res, 200, {
      ok: true,
      requestedBy: teacher.email || teacher.uid,
      resourceId: acquireResult.resourceId,
      sid: startResult.sid,
      recorderUid: cloudRecorderUid,
      agoraResponse: startResult,
    });
  } catch (error) {
    console.error("agoraRecordingStart", error);
    json(res, error.statusCode || 500, {
      ok: false,
      error: error.message || "Internal error",
      details: error.details || null,
    });
  }
};
