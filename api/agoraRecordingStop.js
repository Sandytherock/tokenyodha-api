const {
  json,
  requireTeacher,
  setCors,
  stopCompositeRecording,
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

    const stopResult = await stopCompositeRecording({
      resourceId,
      sid,
      channelName,
      recorderUid,
    });

    let recordingFiles = [];
    const rawFileList = stopResult?.serverResponse?.fileList;
    if (typeof rawFileList === "string") {
      try {
        recordingFiles = JSON.parse(rawFileList);
      } catch (error) {
        recordingFiles = [];
      }
    } else if (Array.isArray(rawFileList)) {
      recordingFiles = rawFileList;
    }

    const primaryFile =
      recordingFiles.find((item) => String(item?.fileName || "").toLowerCase().endsWith(".mp4")) ||
      recordingFiles.find((item) => String(item?.fileName || "").toLowerCase().endsWith(".m3u8")) ||
      recordingFiles[0] ||
      null;

    json(res, 200, {
      ok: true,
      requestedBy: teacher.email || teacher.uid,
      agoraResponse: stopResult,
      recordingFiles,
      primaryFile,
    });
  } catch (error) {
    console.error("agoraRecordingStop", error);
    json(res, error.statusCode || 500, {
      ok: false,
      error: error.message || "Internal error",
      details: error.details || null,
    });
  }
};
