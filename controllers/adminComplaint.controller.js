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
      .populate({ path: "orderId", select: "scheduledDate status totalAmount serviceSubCategory", populate: { path: "primaryService", select: "name" } })
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
          orderId: c.orderId?._id,
          issueType: c.issueType,
          description: c.description,
          status: c.status,
          resolution: c.resolution,
          refundAmount: c.refundAmount,
          reServiceScheduled: c.reServiceScheduled,
          createdAt: c.createdAt,
          order: {
            serviceName: c.orderId?.primaryService?.name || c.orderId?.serviceSubCategory || "—",
            scheduledDate: c.orderId?.scheduledDate,
            status: c.orderId?.status,
            totalAmount: c.orderId?.totalAmount,
          },
          user: {
            name: c.userId?.name || "—",
            phone: c.userId?.phone || "—",
            email: c.userId?.email || "—",
          },
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
      .populate("orderId", "scheduledDate status totalAmount primaryService")
      .populate("userId", "name phone email");

    if (!complaint) {
      return res.status(404).json({
        success: false,
        message: "Complaint not found"
      });
    }

    const timeline = await ComplaintTimeline.find({ complaintId: id })
      .sort({ createdAt: 1 })
      .populate("updatedBy", "name");

    // Flatten response so frontend can use res.data directly
    res.json({
      success: true,
      data: {
        id: complaint._id,
        orderId: complaint.orderId?._id,
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
        order: {
          serviceName: complaint.orderId?.primaryService?.name || complaint.orderId?.serviceSubCategory || "—",
          scheduledDate: complaint.orderId?.scheduledDate,
          status: complaint.orderId?.status,
          totalAmount: complaint.orderId?.totalAmount,
        },
        user: {
          name: complaint.userId?.name || "—",
          phone: complaint.userId?.phone || "—",
          email: complaint.userId?.email || "—",
        },
        timeline: timeline.map(t => ({
          id: t._id,
          status: t.status,
          previousStatus: t.previousStatus,
          notes: t.notes,
          adminName: t.updatedBy?.name || "Admin",
          createdAt: t.createdAt,
        })),
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
    const adminId = req.adminUser.id;
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
    const adminId = req.adminUser.id;

    const complaint = await Complaint.findById(id).populate("userId", "fcmToken");
    if (!complaint) {
      return res.status(404).json({
        success: false,
        message: "Complaint not found"
      });
    }

    const previousStatus = complaint.status;

    // Update resolution details and mark as RESOLVED
    if (resolution) complaint.resolution = resolution;
    if (refundAmount !== undefined) complaint.refundAmount = refundAmount;
    if (reServiceScheduled !== undefined) complaint.reServiceScheduled = reServiceScheduled;
    if (adminNotes) complaint.adminNotes = adminNotes;
    complaint.status = "RESOLVED";

    await complaint.save();

    // Create timeline entry
    const timeline = new ComplaintTimeline({
      complaintId: complaint._id,
      status: "RESOLVED",
      previousStatus,
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