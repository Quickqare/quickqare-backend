const Complaint = require("../models/Complaint");
const ComplaintTimeline = require("../models/ComplaintTimeline");
const Booking = require("../models/Booking");
const User = require("../models/User");
const { emitComplaintStatusUpdate } = require("../socket/emitters");
const { sendPushNotification } = require("../services/pushNotification.service");

/**
 * Get all complaints for admin
 */
const getAllComplaints = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, issueType } = req.query;

    const query = {};
    if (status) query.status = status;
    if (issueType) query.issueType = issueType;

    const complaints = await Complaint.find(query)
      .populate("orderId", "serviceName scheduledDate status totalAmount")
      .populate("userId", "name phone")
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Complaint.countDocuments(query);

    res.json({
      success: true,
      data: {
        complaints: complaints.map(c => ({
          id: c._id,
          orderId: c.orderId,
          userId: c.userId,
          issueType: c.issueType,
          description: c.description,
          status: c.status,
          resolution: c.resolution,
          refundAmount: c.refundAmount,
          reServiceScheduled: c.reServiceScheduled,
          createdAt: c.createdAt,
          order: c.orderId,
          user: c.userId,
        })),
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit),
        }
      }
    });
  } catch (error) {
    console.error("Get all complaints error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get complaints"
    });
  }
};

/**
 * Get complaint details for admin
 */
const getComplaintDetailsAdmin = async (req, res) => {
  try {
    const { id } = req.params;

    const complaint = await Complaint.findById(id)
      .populate("orderId")
      .populate("userId", "name phone email");

    if (!complaint) {
      return res.status(404).json({
        success: false,
        message: "Complaint not found"
      });
    }

    const timeline = await ComplaintTimeline.find({ complaintId: id })
      .sort({ createdAt: -1 })
      .populate("updatedBy", "name");

    res.json({
      success: true,
      data: {
        complaint: {
          id: complaint._id,
          orderId: complaint.orderId,
          userId: complaint.userId,
          issueType: complaint.issueType,
          description: complaint.description,
          images: complaint.images,
          status: complaint.status,
          resolution: complaint.resolution,
          refundAmount: complaint.refundAmount,
          reServiceScheduled: complaint.reServiceScheduled,
          adminNotes: complaint.adminNotes,
          createdAt: complaint.createdAt,
          updatedAt: complaint.updatedAt,
          order: complaint.orderId,
          user: complaint.userId,
        },
        timeline: timeline.map(t => ({
          id: t._id,
          status: t.status,
          previousStatus: t.previousStatus,
          notes: t.notes,
          createdAt: t.createdAt,
          updatedBy: t.updatedBy,
        }))
      }
    });
  } catch (error) {
    console.error("Get complaint details admin error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get complaint details"
    });
  }
};

/**
 * Update complaint status
 */
const updateComplaintStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    const adminId = req.admin.id;

    // Validate status
    const validStatuses = ["SUBMITTED", "UNDER_REVIEW", "IN_PROGRESS", "RESOLVED", "CLOSED"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status"
      });
    }

    const complaint = await Complaint.findById(id).populate("userId", "fcmToken");
    if (!complaint) {
      return res.status(404).json({
        success: false,
        message: "Complaint not found"
      });
    }

    const previousStatus = complaint.status;
    complaint.status = status;
    await complaint.save();

    // Create timeline entry
    const timeline = new ComplaintTimeline({
      complaintId: complaint._id,
      status,
      previousStatus,
      updatedBy: adminId,
      notes: notes || `Status updated to ${status}`,
    });

    await timeline.save();

    // Send push notification to user
    if (complaint.userId.fcmToken) {
      console.log(`Sending notification to user ${complaint.userId._id}: Complaint status updated to ${status}`);
      await sendPushNotification(
        complaint.userId.fcmToken,
        "Complaint Update",
        `Your complaint status has been updated to ${status}`,
        { type: "COMPLAINT_UPDATE", complaintId: String(complaint._id) }
      );
    }

    // Emit socket event
    emitComplaintStatusUpdate(complaint.userId._id, {
      complaintId: complaint._id,
      status,
      message: `Your complaint status has been updated to ${status}`,
    });

    res.json({
      success: true,
      message: "Complaint status updated successfully",
      data: { complaint }
    });
  } catch (error) {
    console.error("Update complaint status error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update complaint status"
    });
  }
};

/**
 * Add resolution to complaint
 */
const addComplaintResolution = async (req, res) => {
  try {
    const { id } = req.params;
    const { resolution, refundAmount, reServiceScheduled, adminNotes } = req.body;
    const adminId = req.admin.id;

    const complaint = await Complaint.findById(id).populate("userId", "fcmToken");
    if (!complaint) {
      return res.status(404).json({
        success: false,
        message: "Complaint not found"
      });
    }

    // Update resolution details
    if (resolution) complaint.resolution = resolution;
    if (refundAmount !== undefined) complaint.refundAmount = refundAmount;
    if (reServiceScheduled !== undefined) complaint.reServiceScheduled = reServiceScheduled;
    if (adminNotes) complaint.adminNotes = adminNotes;

    await complaint.save();

    // Create timeline entry
    const timeline = new ComplaintTimeline({
      complaintId: complaint._id,
      status: complaint.status,
      updatedBy: adminId,
      notes: "Resolution added/updated",
    });

    await timeline.save();

    // Send push notification
    if (complaint.userId.fcmToken) {
      console.log(`Sending resolution notification to user ${complaint.userId._id}`);
      await sendPushNotification(
        complaint.userId.fcmToken,
        "Complaint Resolved",
        "A resolution has been added to your complaint. Tap to view details.",
        { type: "COMPLAINT_RESOLUTION", complaintId: String(complaint._id) }
      );
    }

    res.json({
      success: true,
      message: "Complaint resolution updated successfully",
      data: { complaint }
    });
  } catch (error) {
    console.error("Add complaint resolution error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update complaint resolution"
    });
  }
};

module.exports = {
  getAllComplaints,
  getComplaintDetailsAdmin,
  updateComplaintStatus,
  addComplaintResolution,
};