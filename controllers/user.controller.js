const User = require("../models/User");
const Booking = require("../models/Booking");
const Complaint = require("../models/Complaint");
const { releaseSlotCapacityByBookingId } = require("../services/slotCapacity.service");

/**
 * Update user profile (name, gender, and optionally email)
 * Limited to 3 times per year
 */
const updateProfile = async (req, res) => {
  try {
    const { name, gender, email } = req.body;
    const userId = req.user.id;

    // Validate input
    if (!name || !gender) {
      return res.status(400).json({
        success: false,
        message: "Name and gender are required"
      });
    }

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Check edit limit (3 times per year)
    const currentYear = new Date().getFullYear();
    const editsThisYear = user.profileEdits.filter(edit => {
      return new Date(edit.date).getFullYear() === currentYear;
    });

    if (editsThisYear.length >= 3) {
      return res.status(429).json({
        success: false,
        message: "You can only edit your profile 3 times per year"
      });
    }

    // Track the changes
    const changes = {};
    if (user.name !== name) changes.name = { from: user.name, to: name };
    if (user.gender !== gender) changes.gender = { from: user.gender, to: gender };
    // Email is optional — only clients that send it (web) update it.
    if (typeof email !== "undefined" && user.email !== email) {
      changes.email = { from: user.email, to: email };
    }

    // Update user
    user.name = name;
    user.gender = gender;
    if (typeof email !== "undefined") user.email = email;
    user.profileEdits.push({
      date: new Date(),
      changes,
    });

    await user.save();

    // Return updated user (without sensitive data)
    const updatedUser = {
      id: user._id,
      name: user.name,
      gender: user.gender,
      phone: user.phone,
      email: user.email,
    };

    res.json({
      success: true,
      message: "Profile updated successfully",
      data: { user: updatedUser }
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update profile"
    });
  }
};

/**
 * Get user profile edit history
 */
const getProfileEditHistory = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId).select("profileEdits");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Calculate remaining edits for current year
    const currentYear = new Date().getFullYear();
    const editsThisYear = user.profileEdits.filter(edit => {
      return new Date(edit.date).getFullYear() === currentYear;
    });

    res.json({
      success: true,
      message: "Profile edit history retrieved",
      data: {
        editsThisYear: editsThisYear.length,
        remainingEdits: Math.max(0, 3 - editsThisYear.length),
        history: user.profileEdits,
      }
    });
  } catch (error) {
    console.error("Get profile edit history error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get profile edit history"
    });
  }
};

/**
 * Update user FCM token for push notifications
 */
const updateFcmToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;
    const userId = req.user.id;

    if (typeof fcmToken !== "string" || !fcmToken.trim()) {
      return res.status(400).json({ success: false, message: "FCM token is required" });
    }
    const token = fcmToken.trim();

    // A device token belongs to ONE account at a time. If someone else was signed
    // in on this phone and didn't sign out cleanly (an app build that never told
    // us, or no network at the time), their record still holds it and their
    // booking pushes would keep arriving on this phone — now that someone else is
    // using it. Move the token here, as the partner endpoint does.
    await User.updateMany({ fcmToken: token, _id: { $ne: userId } }, { $set: { fcmToken: "" } });
    await User.findByIdAndUpdate(userId, { fcmToken: token });

    res.json({ success: true, message: "FCM token updated successfully" });
  } catch (error) {
    console.error("Update FCM token error:", error);
    res.status(500).json({ success: false, message: "Failed to update FCM token" });
  }
};

/**
 * Remove this device's FCM token — the customer logged out of the app.
 * DELETE /api/user/fcm-token   body: { fcmToken }
 *
 * Clears it only if it is still the token on file: the customer may have signed
 * in on another phone since, and that phone's token must keep working.
 */
const removeFcmToken = async (req, res) => {
  try {
    const { fcmToken } = req.body || {};

    if (typeof fcmToken !== "string" || !fcmToken.trim()) {
      return res.status(400).json({ success: false, message: "FCM token is required" });
    }

    await User.updateOne({ _id: req.user.id, fcmToken: fcmToken.trim() }, { $set: { fcmToken: "" } });

    res.json({ success: true, message: "FCM token removed" });
  } catch (error) {
    console.error("Remove FCM token error:", error);
    res.status(500).json({ success: false, message: "Failed to remove FCM token" });
  }
};

/**
 * Delete account (soft delete — anonymise PII)
 * Blocked if user has active bookings or open complaints.
 * DELETE /api/user/me
 */
const deleteAccount = async (req, res) => {
  try {
    const userId = req.user.id;
    const { reason = "" } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (user.isDeleted) {
      return res.status(400).json({ success: false, message: "Account already deleted" });
    }

    // Block if active/upcoming bookings exist. PENDING_PAYMENT is deliberately
    // not in this list: a checkout the customer started and never paid for is not
    // "an upcoming booking". It is hidden from their bookings (they can't see it,
    // let alone cancel it) and lingers up to 48 h until the stale-booking cron
    // removes it — which used to block deleting the account for that long. Those
    // are cancelled below instead. (A guest add-on still waiting for payment IS
    // visible to the customer, who can pay or decline it, so it still blocks.)
    const activeBookingStatuses = [
      "PENDING_ASSIGNMENT",
      "QUEUED",
      "SEARCHING",
      "ASSIGNING_LOCK",
      "ASSIGNED",
      "CONFIRMED",
      "NO_PARTNER_AVAILABLE",
      "PARTNER_ACCEPTED",
      "ON_THE_WAY",
      "ARRIVED",
      "IN_PROGRESS",
    ];
    const findActiveBooking = () =>
      Booking.findOne({
        user: userId,
        $or: [
          { status: { $in: activeBookingStatuses } },
          { status: "PENDING_PAYMENT", origin: "partner_onspot" },
        ],
      }).lean();
    const refuseActiveBooking = () =>
      res.status(400).json({
        success: false,
        code: "ACTIVE_BOOKING",
        message: "You have an active or upcoming booking. Please cancel or wait for it to complete before deleting your account.",
      });

    if (await findActiveBooking()) {
      return refuseActiveBooking();
    }

    // Block if open complaints/disputes exist
    const openComplaint = await Complaint.findOne({
      userId,
      status: { $in: ["SUBMITTED", "UNDER_REVIEW", "IN_PROGRESS"] },
    }).lean();
    if (openComplaint) {
      return res.status(400).json({
        success: false,
        code: "OPEN_COMPLAINT",
        message: "You have an open complaint that is being reviewed. Please wait for it to be resolved before deleting your account.",
      });
    }

    // Close the checkouts they abandoned (done only now, once nothing else can
    // refuse the deletion) and give back the slots they were holding. Guarded on
    // still being unpaid: a payment that lands in this instant keeps its booking.
    const abandoned = await Booking.find({
      user: userId,
      status: "PENDING_PAYMENT",
      origin: { $ne: "partner_onspot" },
      "payment.status": { $ne: "PAID" },
    })
      .select("_id")
      .lean();

    for (const { _id } of abandoned) {
      const cancelled = await Booking.findOneAndUpdate(
        { _id, status: "PENDING_PAYMENT", "payment.status": { $ne: "PAID" } },
        {
          $set: {
            status: "CANCELLED",
            "payment.status": "FAILED",
            cancelledBy: "user",
            cancelledAt: new Date(),
            cancelReason: "Account deleted",
          },
        }
      );
      if (cancelled) {
        await releaseSlotCapacityByBookingId(_id, { releaseReason: "account_deleted" });
      }
    }

    // One of those may have been paid in the instant we were cancelling it: it is
    // now a real booking, so the account can't be deleted after all.
    if (abandoned.length && (await findActiveBooking())) {
      return refuseActiveBooking();
    }

    // Anonymise PII so the phone number is freed for re-registration
    user.name = "Deleted User";
    user.gender = "";
    user.email = "";
    user.fcmToken = "";
    user.referralCode = undefined;
    user.phone = `deleted_${userId}`;
    user.status = "BLOCKED";
    user.isDeleted = true;
    user.deletedAt = new Date();
    user.deleteReason = reason;
    await user.save();

    res.json({ success: true, message: "Account deleted successfully" });
  } catch (error) {
    console.error("Delete account error:", error);
    res.status(500).json({ success: false, message: "Failed to delete account" });
  }
};

module.exports = {
  updateProfile,
  getProfileEditHistory,
  updateFcmToken,
  removeFcmToken,
  deleteAccount,
};