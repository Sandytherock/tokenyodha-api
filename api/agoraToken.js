const { RtcTokenBuilder, RtcRole } = require('agora-token');

module.exports = async function handler(req, res) {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    const { channelName, uid, role } = req.body || {};
    if (!channelName) {
      res.status(400).send('channelName required');
      return;
    }

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    if (!appId || !appCertificate) {
      res.status(500).send('Missing AGORA_APP_ID / AGORA_APP_CERTIFICATE');
      return;
    }

    const expireSeconds = Number(process.env.AGORA_TOKEN_EXPIRY_SECONDS || 3600);
    const currentTs = Math.floor(Date.now() / 1000);
    const privilegeExpireTs = currentTs + expireSeconds;

    const rtcRole = role === 'broadcaster' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;

    let token;
    if (typeof uid === 'string') {
      token = RtcTokenBuilder.buildTokenWithUserAccount(appId, appCertificate, channelName, uid, rtcRole, privilegeExpireTs);
    } else {
      const numericUid = Number(uid || 0);
      token = RtcTokenBuilder.buildTokenWithUid(appId, appCertificate, channelName, numericUid, rtcRole, privilegeExpireTs);
    }

    res.status(200).json({ token, expireSeconds });
  } catch (e) {
    console.error(e);
    res.status(500).send(e?.message || 'Internal error');
  }
};
