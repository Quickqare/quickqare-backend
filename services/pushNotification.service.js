const admin = require("../config/firebase");

async function sendPushNotification(token, title, body, data = {}) {
  if (!token || !admin.apps.length) return;

  await admin.messaging().send({
    token,
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, String(value)])
    ),
    android: {
      priority: "high",
    },
  });
}

module.exports = {
  sendPushNotification,
};

