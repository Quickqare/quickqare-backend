const Complaint = require("../models/Complaint");
const ComplaintTimeline = require("../models/ComplaintTimeline");
const Booking = require("../models/Booking");
const User = require("../models/User");
const { emitComplaintStatusUpdate } = require("../socket/emitters");

/**
 * Create a new complaint
 */
const createComplaint = async (req, res) => {
  try {
    const { orderId, issueType, description, images } = req.body;
    const userId = req.user.id;

    // Validate required fields
    if (!orderId || !issueType || !description) {
      return res.status(400).json({
        success: false,
        message: "Order ID, issue type, and description are required"
      });
    }

    // Check if booking exists and belongs to user
    const booking = await Booking.findOne({ _id: orderId, userId });
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Order not found or doesn't belong to you"
      });
    }

    // Check if booking is in valid state for complaints
    if (!["COMPLETED", "CANCELLED"].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: "Complaints can only be raised for completed or cancelled orders"
      });
    }

    // Check if complaint already exists for this order
    const existingComplaint = await Complaint.findOne({ orderId, userId });
    if (existingComplaint) {
      return res.status(400).json({
        success: false,
        message: "A complaint already exists for this order"
      });
    }

    // Create complaint
    const complaint = new Complaint({
      orderId,
      userId,
      issueType,
      description,
      images: images || [],
    });

    await complaint.save();

    // Create timeline entry
    const timeline = new ComplaintTimeline({
      complaintId: complaint._id,
      status: "SUBMITTED",
      notes: "Complaint submitted by user",
    });

    await timeline.save();

    // Populate booking details for response
    await complaint.populate("orderId", "serviceName scheduledDate status");

    res.status(201).json({
      success: true,
      message: "Complaint submitted successfully",
      data: {
        complaint: {
          id: complaint._id,
          orderId: complaint.orderId,
          issueType: complaint.issueType,
          description: complaint.description,
          images: complaint.images,
          status: complaint.status,
          createdAt: complaint.createdAt,
        }
      }
    });
  } catch (error) {
    console.error("Create complaint error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create complaint"
    });
  }
};

/**
 * Get user's complaints
 */
const getUserComplaints = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 10, status } = req.query;

    const query = { userId };
    if (status) query.status = status;

    const complaints = await Complaint.find(query)
      .populate("orderId", "serviceName scheduledDate status")
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
          issueType: c.issueType,
          description: c.description,
          status: c.status,
          createdAt: c.createdAt,
          order: c.orderId,
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
    console.error("Get user complaints error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get complaints"
    });
  }
};

/**
 * Get complaint details with timeline
 */
const getComplaintDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const complaint = await Complaint.findOne({ _id: id, userId })
      .populate("orderId", "serviceName scheduledDate status totalAmount");

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
          issueType: complaint.issueType,
          description: complaint.description,
          images: complaint.images,
          status: complaint.status,
          resolution: complaint.resolution,
          refundAmount: complaint.refundAmount,
          reServiceScheduled: complaint.reServiceScheduled,
          createdAt: complaint.createdAt,
          updatedAt: complaint.updatedAt,
          order: complaint.orderId,
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
    console.error("Get complaint details error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get complaint details"
    });
  }
};

module.exports = {
  createComplaint,
  getUserComplaints,
  getComplaintDetails,
};