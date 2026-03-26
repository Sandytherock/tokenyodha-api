const {
  json,
  queryCompositeRecording,
  requireTeacher,
  setCors,
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
    const { resourceId, sid, channelName, recorderUid } = req.body || {};

    if (!resourceId || !sid || !channelName || recorderUid == null) {
      json(res, 400, { error: "resourceId, sid, channelName, recorderUid required" });
      return;
    }

    const queryResult = await queryCompositeRecording({
      resourceId,
      sid,
      channelName,
      recorderUid,
    });

    json(res, 200, {
      ok: true,
      requestedBy: teacher.email || teacher.uid,
      agoraResponse: queryResult,
    });
  } catch (error) {
    console.error("agoraRecordingQuery", error);
    json(res, error.statusCode || 500, {
      ok: false,
      error: error.message || "Internal error",
      details: error.details || null,
    });
  }
};
