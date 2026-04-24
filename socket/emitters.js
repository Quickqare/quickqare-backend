let ioInstance = null;

/* =====================================================
   SOCKET EVENT CONSTANTS
===================================================== */
const EVENTS = {
  BOOKING_UPDATE: "booking_update",
  JOB_ASSIGNED: "job_assigned",
  JOB_CANCELLED: "job_cancelled",
  JOB_COMPLETED: "job_completed",
  COMPLAINT_UPDATE: "complaint_update",
};

/* =====================================================
   SAFE EMIT HELPER
===================================================== */
function safeEmit(room, event, payload) {
  try {
    if (!ioInstance || !room) return;

    ioInstance.to(room).emit(event, payload);

    console.log(`📡 ${event} → ${room}`);
  } catch (error) {
    console.error("Socket emit error:", error.message);
  }
}

/* =====================================================
   SET SOCKET INSTANCE
   Called once from index.js
===================================================== */
exports.setSocketIO = (io) => {
  ioInstance = io;
  console.log("✅ Socket.IO initialized");
};

/* =====================================================
   USER BOOKING STATUS UPDATE
   (SEARCHING, ASSIGNED, ON_THE_WAY, COMPLETED, etc.)
===================================================== */
exports.emitBookingUpdate = (booking) => {
  if (!booking?.user) return;

  const room = `user_${booking.user.toString()}`;

  safeEmit(room, EVENTS.BOOKING_UPDATE, {
    bookingId: booking._id?.toString(),
    status: booking.status,
    partnerId: booking.partner || null,
    updatedAt: new Date(),
  });
};

/* =====================================================
   JOB ASSIGNED TO PARTNER
===================================================== */
exports.emitJobAssignedToPartner = (partnerId, payload = {}) => {
  if (!partnerId) return;

  const room = `partner_${partnerId.toString()}`;

  safeEmit(room, EVENTS.JOB_ASSIGNED, {
    ...payload,
    timestamp: new Date(),
  });
};

/* =====================================================
   JOB CANCELLED
===================================================== */
exports.emitJobCancelled = (userId, partnerId, bookingId) => {
  if (!bookingId) return;

  if (userId) {
    safeEmit(`user_${userId}`, EVENTS.JOB_CANCELLED, {
      bookingId,
      timestamp: new Date(),
    });
  }

  if (partnerId) {
    safeEmit(`partner_${partnerId}`, EVENTS.JOB_CANCELLED, {
      bookingId,
      timestamp: new Date(),
    });
  }
};

/* =====================================================
   JOB COMPLETED
===================================================== */
exports.emitJobCompleted = (userId, bookingId) => {
  if (!userId || !bookingId) return;

  safeEmit(`user_${userId}`, EVENTS.JOB_COMPLETED, {
    bookingId,
    timestamp: new Date(),
  });
};

/* =====================================================
   COMPLAINT STATUS UPDATE
===================================================== */
exports.emitComplaintStatusUpdate = (userId, payload) => {
  if (!userId) return;

  const room = `user_${userId.toString()}`;

  safeEmit(room, EVENTS.COMPLAINT_UPDATE, {
    ...payload,
    timestamp: new Date(),
  });
};

/* =====================================================
   EXPORT EVENTS (useful in frontend)
===================================================== */
exports.SOCKET_EVENTS = EVENTS;