const express = require("express");
const router = express.Router();
const {
  updateProfile,
  getProfileEditHistory,
  updateFcmToken,
} = require("../controllers/user.controller");
const userAuth = require("../middlewares/userAuth");

/**
 * Update user profile
 * PATCH /api/user/profile
 */
router.patch("/profile", userAuth, updateProfile);

/**
 * Get profile edit history
 * GET /api/user/profile/history
 */
router.get("/profile/history", userAuth, getProfileEditHistory);

/**
 * Save the customer's FCM token for push notifications
 * PATCH /api/user/update-fcm
 */
router.patch("/update-fcm", userAuth, updateFcmToken);

module.exports = router;