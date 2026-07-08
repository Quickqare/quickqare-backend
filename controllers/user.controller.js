const User = require("../models/User");
const Booking = require("../models/Booking");
const Complaint = require("../models/Complaint");

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

    if (!fcmToken) {
      return res.status(400).json({ success: false, message: "FCM token is required" });
    }

    await User.findByIdAndUpdate(userId, { fcmToken });

    res.json({ success: true, message: "FCM token updated successfully" });
  } catch (error) {
    console.error("Update FCM token error:", error);
    res.status(500).json({ success: false, message: "Failed to update FCM token" });
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

    // Block if active/upcoming bookings exist
    const activeBookingStatuses = [
      "PENDING_PAYMENT",
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
    const activeBooking = await Booking.findOne({
      user: userId,
      status: { $in: activeBookingStatuses },
    }).lean();
    if (activeBooking) {
      return res.status(400).json({
        success: false,
        code: "ACTIVE_BOOKING",
        message: "You have an active or upcoming booking. Please cancel or wait for it to complete before deleting your account.",
      });
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
  deleteAccount,
};