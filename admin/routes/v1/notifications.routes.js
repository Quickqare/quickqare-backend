const express = require("express");
const authenticateAdmin = require("../../middleware/authenticateAdmin");
const authorize = require("../../middleware/authorize");
const audit = require("../../middleware/audit");
const { PERMISSIONS } = require("../../constants/permissions");
const { success, fail } = require("../../utils/response");
const { sendPromoBroadcast } = require("../../../services/pushNotification.service");

const router = express.Router();

router.use(authenticateAdmin, authorize(PERMISSIONS.SETTINGS_MANAGE));

// Android truncates banner text well before these caps; they exist to stop
// accidental essay-length sends, not to match a hard FCM limit.
const TITLE_MAX = 100;
const BODY_MAX = 240;

/*
 * POST /notifications/broadcast
 * Sends a promotional push to every customer device subscribed to the
 * "promos" FCM topic (the customer app subscribes at login — only app
 * versions with that code receive broadcasts). Fire-once: there is no
 * retry/queue here; a failed send returns the error to the admin.
 */
router.post("/broadcast", audit("admin.notifications.broadcast"), async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const body = String(req.body?.body || "").trim();
    const imageUrl = String(req.body?.imageUrl || "").trim();

    if (!title || !body) {
      return fail(res, 400, "VALIDATION", "Both title and message are required", null, {
        requestId: req.requestId,
      });
    }
    if (title.length > TITLE_MAX || body.length > BODY_MAX) {
      return fail(
        res,
        400,
        "VALIDATION",
        `Title must be ≤ ${TITLE_MAX} characters and message ≤ ${BODY_MAX}`,
        null,
        { requestId: req.requestId }
      );
    }
    if (imageUrl && !/^https:\/\//i.test(imageUrl)) {
      return fail(res, 400, "VALIDATION", "Image URL must be https", null, {
        requestId: req.requestId,
      });
    }

    const messageId = await sendPromoBroadcast({
      title,
      body,
      imageUrl: imageUrl || undefined,
    });

    return success(res, { messageId }, { requestId: req.requestId });
  } catch (error) {
    return fail(res, 500, "BROADCAST_FAILED", "Unable to send broadcast", error.message, {
      requestId: req.requestId,
    });
  }
});

module.exports = router;
