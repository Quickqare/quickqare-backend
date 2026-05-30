const express = require("express");
const router = express.Router();
const {
  updateProfile,
  getProfileEditHistory,
  updateFcmToken,
  deleteAccount,
} = require("../controllers/user.controller");
const userAuth = require("../middlewares/userAuth");
const validate = require("../middlewares/validate");
const { updateProfileValidator } = require("../middlewares/validators");

/**
 * Update user profile
 * PATCH /api/user/profile
 */
router.patch("/profile", userAuth, updateProfileValidator, validate, updateProfile);

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

/**
 * Delete account (soft delete — anonymise PII, cancel active bookings)
 * DELETE /api/user/me
 */
router.delete("/me", userAuth, deleteAccount);

module.exports = router;