const Partner = require("../models/Partner");
const Booking = require("../models/Booking");
const TechnicianHelper = require("../models/TechnicianHelper");
const { sendPushNotification } = require("../services/pushNotification.service");

/* Statuses during which a technician may still edit the booking's helpers —
   anything before the partner reaches the customer. */
const HELPER_EDITABLE_STATUSES = [
  "ASSIGNED",
  "CONFIRMED",
  "PARTNER_ACCEPTED",
  "ON_THE_WAY",
];

const HELPER_JOB_STATUSES = [
  "ASSIGNED",
  "CONFIRMED",
  "PARTNER_ACCEPTED",
  "ON_THE_WAY",
  "ARRIVED",
  "IN_PROGRESS",
  "COMPLETED",
];

/* =====================================================
   INVITE HELPER (TECHNICIAN)
   POST /api/partner/helpers/invite
   Body: { phone }
===================================================== */
exports.inviteHelper = async (req, res) => {
  try {
    const technician = req.partner;
    const phone = String(req.body?.phone || "").trim();

    if (technician.skillTier !== 2) {
      return res.status(403).json({
        success: false,
        message: "Only AC technicians can invite helpers",
      });
    }

    if (phone.length !== 10) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid 10-digit phone number",
      });
    }

    const helper = await Partner.findOne({ phone }).select(
      "_id name phone isBlocked fcmToken"
    );
    if (!helper) {
      return res.status(404).json({
        success: false,
        message:
          "No partner is registered with this number. Ask them to install the app and sign up first.",
      });
    }

    if (String(helper._id) === String(technician._id)) {
      return res.status(400).json({
        success: false,
        message: "You cannot invite yourself as a helper",
      });
    }

    if (helper.isBlocked) {
      return res.status(400).json({
        success: false,
        message: "This partner account is blocked",
      });
    }

    // A helper can be linked or invited to only one technician at a time.
    const existingLink = await TechnicianHelper.findOne({
      helper: helper._id,
      status: { $in: ["PENDING", "ACTIVE"] },
    });

    if (existingLink) {
      if (String(existingLink.technician) === String(technician._id)) {
        return res.status(409).json({
          success: false,
          message:
            existingLink.status === "ACTIVE"
              ? "This helper already works with you"
              : "You have already sent an invitation to this helper",
        });
      }
      return res.status(409).json({
        success: false,
        message:
          "This helper is already linked to another technician. Contact admin to reassign them.",
      });
    }

    // Reuse a prior REJECTED/REMOVED row — the (technician, helper) index is unique.
    let invite = await TechnicianHelper.findOne({
      technician: technician._id,
      helper: helper._id,
    });

    if (invite) {
      invite.status = "PENDING";
      invite.invitePhone = phone;
      invite.invitedAt = new Date();
      invite.respondedAt = null;
      invite.removedAt = null;
      invite.removedBy = null;
      await invite.save();
    } else {
      invite = await TechnicianHelper.create({
        technician: technician._id,
        helper: helper._id,
        invitePhone: phone,
        status: "PENDING",
      });
    }

    if (helper.fcmToken) {
      sendPushNotification(
        helper.fcmToken,
        "Helper Invitation",
        `${technician.name} invited you to join their team as a helper.`,
        { type: "HELPER_INVITE", invitationId: String(invite._id) }
      );
    }

    return res.status(201).json({
      success: true,
      message: "Invitation sent",
      invitation: {
        id: String(invite._id),
        helperId: String(helper._id),
        helperName: helper.name,
        helperPhone: helper.phone,
        status: invite.status,
      },
    });
  } catch (err) {
    console.error("inviteHelper error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* =====================================================
   LIST MY HELPERS (TECHNICIAN)
   GET /api/partner/helpers
===================================================== */
exports.listHelpers = async (req, res) => {
  try {
    const rows = await TechnicianHelper.find({
      technician: req.partner._id,
      status: { $in: ["PENDING", "ACTIVE"] },
    })
      .populate("helper", "name phone rating isOnline")
      .sort({ createdAt: -1 })
      .lean();

    const mapped = rows
      .filter((r) => r.helper)
      .map((r) => ({
        invitationId: String(r._id),
        status: r.status,
        helperId: String(r.helper._id),
        name: r.helper.name,
        phone: r.helper.phone,
        rating: r.helper.rating ?? 5,
        isOnline: Boolean(r.helper.isOnline),
        invitedAt: r.invitedAt,
        respondedAt: r.respondedAt,
      }));

    return res.json({
      success: true,
      activeHelpers: mapped.filter((h) => h.status === "ACTIVE"),
      pendingInvites: mapped.filter((h) => h.status === "PENDING"),
    });
  } catch (err) {
    console.error("listHelpers error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* =====================================================
   LIST INVITATIONS RECEIVED (HELPER)
   GET /api/partner/helper/invitations
===================================================== */
exports.listInvitations = async (req, res) => {
  try {
    const rows = await TechnicianHelper.find({
      helper: req.partner._id,
      status: "PENDING",
    })
      .populate("technician", "name phone rating")
      .sort({ createdAt: -1 })
      .lean();

    const invitations = rows
      .filter((r) => r.technician)
      .map((r) => ({
        invitationId: String(r._id),
        technicianId: String(r.technician._id),
        technicianName: r.technician.name,
        technicianPhone: r.technician.phone,
        technicianRating: r.technician.rating ?? 5,
        invitedAt: r.invitedAt,
      }));

    return res.json({ success: true, count: invitations.length, invitations });
  } catch (err) {
    console.error("listInvitations error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* =====================================================
   RESPOND TO INVITATION (HELPER)
   POST /api/partner/helper/invitations/respond
   Body: { invitationId, action: "ACCEPT" | "REJECT" }
===================================================== */
exports.respondToInvitation = async (req, res) => {
  try {
    const helperId = req.partner._id;
    const { invitationId } = req.body;
    const action = String(req.body?.action || "").toUpperCase();

    if (!invitationId || !["ACCEPT", "REJECT"].includes(action)) {
      return res.status(400).json({
        success: false,
        message: "invitationId and action (ACCEPT or REJECT) are required",
      });
    }

    const invite = await TechnicianHelper.findOne({
      _id: invitationId,
      helper: helperId,
      status: "PENDING",
    }).populate("technician", "name fcmToken");

    if (!invite) {
      return res.status(404).json({
        success: false,
        message: "Invitation not found or already responded",
      });
    }

    if (action === "REJECT") {
      invite.status = "REJECTED";
      invite.respondedAt = new Date();
      await invite.save();

      if (invite.technician?.fcmToken) {
        sendPushNotification(
          invite.technician.fcmToken,
          "Helper Invitation Declined",
          `${req.partner.name} declined your helper invitation.`,
          { type: "HELPER_INVITE_DECLINED" }
        );
      }

      return res.json({ success: true, message: "Invitation declined" });
    }

    // ACCEPT — a helper can only have one active technician.
    const otherActive = await TechnicianHelper.findOne({
      helper: helperId,
      status: "ACTIVE",
      _id: { $ne: invite._id },
    });
    if (otherActive) {
      return res.status(409).json({
        success: false,
        message:
          "You already work with another technician. Contact admin to switch.",
      });
    }

    invite.status = "ACTIVE";
    invite.respondedAt = new Date();
    try {
      await invite.save();
    } catch (e) {
      if (e && e.code === 11000) {
        return res.status(409).json({
          success: false,
          message:
            "You already work with another technician. Contact admin to switch.",
        });
      }
      throw e;
    }

    if (invite.technician?.fcmToken) {
      sendPushNotification(
        invite.technician.fcmToken,
        "Helper Joined Your Team",
        `${req.partner.name} accepted your invitation and is now your helper.`,
        { type: "HELPER_INVITE_ACCEPTED" }
      );
    }

    return res.json({
      success: true,
      message: `You are now a helper for ${invite.technician?.name || "your technician"}`,
    });
  } catch (err) {
    console.error("respondToInvitation error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* =====================================================
   SET HELPERS ON A BOOKING (TECHNICIAN)
   POST /api/partner/booking/helpers
   Body: { bookingId, helperIds: [] }
===================================================== */
exports.setBookingHelpers = async (req, res) => {
  try {
    const technicianId = req.partner._id;
    const { bookingId, helperIds } = req.body;

    if (!bookingId || !Array.isArray(helperIds)) {
      return res.status(400).json({
        success: false,
        message: "bookingId and a helperIds array are required",
      });
    }

    const booking = await Booking.findOne({
      _id: bookingId,
      partner: technicianId,
      status: { $in: HELPER_EDITABLE_STATUSES },
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message:
          "Booking not found, not assigned to you, or can no longer be edited",
      });
    }

    const uniqueIds = [...new Set(helperIds.map((id) => String(id)))];
    const previousIds = new Set(
      (booking.helpers || []).map((h) => String(h.partnerId))
    );

    let snapshots = [];
    let newlyAdded = [];

    if (uniqueIds.length > 0) {
      const activeRows = await TechnicianHelper.find({
        technician: technicianId,
        helper: { $in: uniqueIds },
        status: "ACTIVE",
      }).populate("helper", "name phone fcmToken");

      const validMap = new Map(
        activeRows
          .filter((r) => r.helper)
          .map((r) => [String(r.helper._id), r.helper])
      );

      const invalid = uniqueIds.filter((id) => !validMap.has(id));
      if (invalid.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Some selected helpers are not your active helpers",
        });
      }

      snapshots = uniqueIds.map((id) => {
        const h = validMap.get(id);
        return {
          partnerId: h._id,
          name: h.name,
          phone: h.phone,
          addedAt: new Date(),
        };
      });

      newlyAdded = uniqueIds
        .filter((id) => !previousIds.has(id))
        .map((id) => validMap.get(id));
    }

    booking.helpers = snapshots;
    await booking.save();

    // Notify only helpers newly added to this job.
    for (const h of newlyAdded) {
      if (h.fcmToken) {
        sendPushNotification(
          h.fcmToken,
          "Added to a Job",
          `${req.partner.name} added you to a job on ${
            booking.scheduledDate
              ? new Date(booking.scheduledDate).toLocaleDateString()
              : "an upcoming date"
          }.`,
          { type: "HELPER_JOB_ADDED", bookingId: String(booking._id) }
        );
      }
    }

    return res.json({
      success: true,
      message: "Helpers updated for this booking",
      helpers: booking.helpers,
    });
  } catch (err) {
    console.error("setBookingHelpers error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* =====================================================
   LIST JOBS I'M A HELPER ON (HELPER)
   GET /api/partner/helper/jobs
===================================================== */
exports.listHelperJobs = async (req, res) => {
  try {
    const bookings = await Booking.find({
      "helpers.partnerId": req.partner._id,
      status: { $in: HELPER_JOB_STATUSES },
    })
      .populate("user", "name phone")
      .populate("partner", "name phone")
      .sort({ scheduledDate: -1 })
      .limit(50)
      .lean();

    const jobs = bookings.map((b) => ({
      bookingId: String(b._id),
      bookingNumber: b.bookingNumber || "",
      status: b.status,
      serviceCategory: b.serviceCategory || "",
      scheduledDate: b.scheduledDate,
      scheduledTime: b.scheduledTime || "",
      address: b.address || "",
      pincode: b.pincode || "",
      customerName: b.user?.name || "Customer",
      customerPhone: b.user?.phone || "",
      technicianName: b.partner?.name || "",
      technicianPhone: b.partner?.phone || "",
    }));

    return res.json({ success: true, count: jobs.length, jobs });
  } catch (err) {
    console.error("listHelperJobs error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
