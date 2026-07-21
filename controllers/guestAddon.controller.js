/**
 * =====================================================
 * GUEST MEHENDI ADD-ON (Phase 2 — partner on-the-spot)
 *
 * A partner working an in-progress Mehendi booking can add "Mehendi for
 * Guests" for walk-up guests at the venue. It is created as its OWN booking,
 * pre-assigned to that same partner, and needs the customer to approve & pay
 * before it becomes active. Kept deliberately isolated from the scheduled
 * booking flow: no slot locks, no assignment engine — the partner is already
 * on-site, so the guest booking goes straight to IN_PROGRESS once paid, and
 * settles through the normal completeBooking path (single partner, no team
 * allocations → fallback credit branch).
 *
 * The lone-guest restriction (utils/pricing + booking.controller) still holds
 * for the customer-facing create flow — this partner-authenticated path is the
 * only sanctioned way a guest-only booking can exist, and it always rides an
 * already-confirmed hand-design booking.
 * =====================================================
 */
const crypto = require("crypto");
const Razorpay = require("razorpay");
const Booking = require("../models/Booking");
const Service = require("../models/service.model");
const { calculatePricing, getPricingSettings } = require("../utils/pricing");

// A single visit can't realistically have hundreds of guests — cap it so a
// mistyped count can't create a huge charge.
const MAX_GUESTS = 50;

const GUEST_SERVICE_NAME_REGEX = /^\s*mehendi for guests\s*$/i;

const isMehendiBooking = (booking) => {
  const cat = String(booking.serviceCategory || "").toLowerCase();
  if (cat.includes("mehendi")) return true;
  return (booking.services || []).some((s) =>
    String(s.category || "").toLowerCase().includes("mehendi")
  );
};

/* =====================================================
   PARTNER: add guest mehendi to an in-progress booking
   POST /api/partner/booking/add-guest-mehendi
   Body: { parentBookingId, quantity }
===================================================== */
exports.createGuestAddon = async (req, res) => {
  try {
    const partnerId = req.partner._id;
    const { parentBookingId, quantity } = req.body;

    const qty = Math.max(1, Math.min(Math.floor(Number(quantity) || 0), MAX_GUESTS));
    if (!parentBookingId || Number(quantity) < 1) {
      return res.status(400).json({
        success: false,
        message: "parentBookingId and a guest count of at least 1 are required",
      });
    }

    // Parent must be THIS partner's booking and actively in progress (they're
    // at the venue). No other state can spawn a guest add-on.
    const parent = await Booking.findOne({
      _id: parentBookingId,
      $or: [{ partner: partnerId }, { additionalPartners: partnerId }],
      status: "IN_PROGRESS",
    });
    if (!parent) {
      return res.status(404).json({
        success: false,
        message: "No in-progress booking of yours found to add guests to",
      });
    }

    if (!isMehendiBooking(parent)) {
      return res.status(400).json({
        success: false,
        message: "Guest mehendi can only be added to a Mehendi booking",
      });
    }

    // Price is ALWAYS resolved server-side from the guest service — the partner
    // never supplies an amount, only the count (which the customer approves).
    const guestService = await Service.findOne({
      name: { $regex: GUEST_SERVICE_NAME_REGEX },
      isActive: true,
    }).lean();
    if (!guestService) {
      return res.status(404).json({
        success: false,
        message: "Guest mehendi service is not available",
      });
    }

    const unitPrice = Number(guestService.price) || 0;
    if (unitPrice <= 0) {
      return res.status(400).json({
        success: false,
        message: "Guest mehendi price is not configured",
      });
    }

    const settings = await getPricingSettings();
    const pricing = calculatePricing({
      services: [{ price: unitPrice, quantity: qty }],
      pricing: settings,
    });

    // Rides the same visit — copy venue + schedule straight from the parent so
    // the required booking fields are well-formed without re-deriving them.
    const guestBooking = await Booking.create({
      user: parent.user,
      partner: partnerId, // pre-assigned to the artist on-site
      origin: "partner_onspot",
      parentBooking: parent._id,
      services: [
        {
          serviceId: guestService._id,
          name: guestService.name,
          price: unitPrice,
          lineTotal: unitPrice * qty,
          quantity: qty,
          category: "mehendi",
        },
      ],
      primaryService: guestService._id,
      serviceCategory: "mehendi",
      baseAmount: pricing.baseAmount,
      discountAmount: 0,
      platformFeeAmount: pricing.platformFeeAmount,
      gstAmount: pricing.gstAmount,
      totalAmount: pricing.totalAmount,
      scheduledDate: parent.scheduledDate,
      scheduledTime: parent.scheduledTime,
      location: parent.location,
      pincode: parent.pincode,
      address: parent.address,
      houseDetails: parent.houseDetails,
      landmark: parent.landmark,
      status: "PENDING_APPROVAL",
      payment: { status: "PENDING" },
    });

    // Real-time nudge to the customer app to approve & pay (mirrors the
    // estimate_submitted pattern used by the parts-estimate flow).
    if (global.io) {
      global.io.to(`user_${parent.user}`).emit("guest_addon_requested", {
        bookingId: guestBooking._id.toString(),
        parentBookingId: parent._id.toString(),
        quantity: qty,
        unitPrice,
        totalAmount: pricing.totalAmount,
      });
    }

    // Explicit projection — never return the raw booking document to a partner
    // (it carries serviceStartCode and payment internals).
    return res.json({
      success: true,
      message: "Guest mehendi sent to the customer for approval",
      booking: {
        id: guestBooking._id.toString(),
        bookingId: guestBooking._id.toString(),
        parentBookingId: parent._id.toString(),
        status: guestBooking.status,
        quantity: qty,
        unitPrice,
        baseAmount: guestBooking.baseAmount,
        totalAmount: guestBooking.totalAmount,
      },
    });
  } catch (err) {
    console.error("createGuestAddon error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// Shared loader for the customer-side actions: enforces ownership + that this
// really is a partner-created guest add-on (never a normal booking).
async function loadOwnedGuestAddon(bookingId, userId) {
  const booking = await Booking.findById(bookingId);
  if (!booking) return { error: { code: 404, message: "Booking not found" } };
  if (String(booking.user) !== String(userId)) {
    return { error: { code: 403, message: "Not authorized for this booking" } };
  }
  if (booking.origin !== "partner_onspot") {
    return { error: { code: 400, message: "Not a guest add-on booking" } };
  }
  return { booking };
}

/* =====================================================
   CUSTOMER: decline a pending guest add-on
   POST /api/booking/:bookingId/guest-addon/decline
===================================================== */
exports.declineGuestAddon = async (req, res) => {
  try {
    const { booking, error } = await loadOwnedGuestAddon(
      req.params.bookingId,
      req.user._id
    );
    if (error) return res.status(error.code).json({ success: false, message: error.message });

    if (booking.payment?.status === "PAID" || booking.status === "COMPLETED") {
      return res.status(400).json({
        success: false,
        message: "This guest add-on has already been paid and can't be declined",
      });
    }
    if (!["PENDING_APPROVAL", "PENDING_PAYMENT"].includes(booking.status)) {
      return res.status(400).json({ success: false, message: "Guest add-on can no longer be declined" });
    }

    booking.status = "CANCELLED";
    booking.cancelledBy = "user";
    booking.cancelReason = "Guest mehendi add-on declined by customer";
    booking.payment.status = "FAILED";
    await booking.save();

    if (global.io && booking.partner) {
      global.io.to(`partner_${booking.partner}`).emit("guest_addon_declined", {
        bookingId: booking._id.toString(),
        parentBookingId: booking.parentBooking ? booking.parentBooking.toString() : null,
      });
    }

    return res.json({ success: true, message: "Guest add-on declined" });
  } catch (err) {
    console.error("declineGuestAddon error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* =====================================================
   CUSTOMER: approve & create Razorpay order for the add-on
   POST /api/booking/:bookingId/guest-addon/create-order
   (No slot lock — this isn't a scheduled slot.)
===================================================== */
exports.createGuestAddonOrder = async (req, res) => {
  try {
    // Fail fast on ownership + booking state before any infra checks, so an
    // unauthorized or invalid request never depends on / leaks gateway config.
    const { booking, error } = await loadOwnedGuestAddon(
      req.params.bookingId,
      req.user._id
    );
    if (error) return res.status(error.code).json({ success: false, message: error.message });

    if (booking.payment?.status === "PAID") {
      return res.status(400).json({ success: false, message: "Guest add-on already paid" });
    }
    // Approving flips PENDING_APPROVAL → PENDING_PAYMENT (re-order allowed while
    // still pending payment, e.g. the customer retried after a dropped attempt).
    if (!["PENDING_APPROVAL", "PENDING_PAYMENT"].includes(booking.status)) {
      return res.status(400).json({ success: false, message: "Guest add-on is not payable" });
    }

    const AdminSetting = require("../admin/models/AdminSetting");
    const settings = await AdminSetting.findOne().lean();
    if (settings?.emergencyLockdown || settings?.paymentsFreezed) {
      return res.status(503).json({
        success: false,
        message: settings?.emergencyLockdown
          ? "Service temporarily unavailable. Please try again later."
          : "Payments are temporarily frozen. Please try again later.",
      });
    }
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ success: false, message: "Razorpay not configured" });
    }

    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    const order = await razorpay.orders.create({
      amount: Math.round(Number(booking.totalAmount || 0) * 100),
      currency: "INR",
      receipt: `guest_${booking._id}`,
    });

    booking.status = "PENDING_PAYMENT";
    booking.payment.razorpay_order_id = order.id;
    booking.payment.status = "PENDING";
    await booking.save();

    return res.json({
      success: true,
      order: { ...order, key_id: process.env.RAZORPAY_KEY_ID },
      booking,
    });
  } catch (err) {
    console.error("createGuestAddonOrder error:", err);
    return res.status(500).json({ success: false, message: "Payment order failed" });
  }
};

/* =====================================================
   CUSTOMER: verify payment → activate the add-on
   POST /api/booking/:bookingId/guest-addon/verify
   On success the pre-assigned partner is already on-site, so it goes straight
   to IN_PROGRESS (no assignment engine). The partner completes it via the
   normal complete endpoint, which credits their wallet.
===================================================== */
exports.verifyGuestAddonPayment = async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Payment verification data missing" });
    }

    const { booking, error } = await loadOwnedGuestAddon(
      req.params.bookingId,
      req.user._id
    );
    if (error) return res.status(error.code).json({ success: false, message: error.message });

    // Idempotency — a re-submitted verify on an already-paid add-on succeeds.
    if (booking.payment?.status === "PAID") {
      return res.json({ success: true, message: "Payment already verified", bookingId: booking._id });
    }

    // Order binding — the submitted order must be the one we created for THIS
    // booking, so a valid signature from a cheaper order can't mark this paid.
    const expectedOrderId = booking.payment?.razorpay_order_id;
    if (!expectedOrderId || String(razorpay_order_id) !== String(expectedOrderId)) {
      return res.status(400).json({ success: false, message: "Payment does not match this booking" });
    }

    if (!process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ success: false, message: "Payment gateway not configured" });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    const expectedBuf = Buffer.from(expectedSignature);
    const providedBuf = Buffer.from(String(razorpay_signature));
    const signatureValid =
      expectedBuf.length === providedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, providedBuf);

    if (!signatureValid) {
      await Booking.updateOne(
        { _id: booking._id, "payment.status": { $ne: "PAID" } },
        { $set: { "payment.status": "FAILED" } }
      );
      return res.status(400).json({ success: false, message: "Invalid payment signature" });
    }

    // Finalize via the shared service so this endpoint and the Razorpay webhook
    // always run identical logic (atomic PAID flip → IN_PROGRESS → partner +
    // customer notifications). Idempotent — whichever path lands first wins.
    const { finalizePaidGuestAddon } = require("../services/paymentFinalize.service");
    const { outcome } = await finalizePaidGuestAddon(booking, {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
    });

    // Declined/cancelled while the checkout was open — money was captured for a
    // dead add-on, so queue a refund instead of silently dropping it.
    if (outcome === "not_payable") {
      await Booking.updateOne(
        { _id: booking._id, "payment.status": { $ne: "PAID" }, refundStatus: { $in: ["NONE", null] } },
        {
          $set: {
            "payment.razorpay_payment_id": razorpay_payment_id,
            refundStatus: "PENDING",
            refundAmount: Number(booking.totalAmount || 0),
          },
        }
      );
      return res.status(409).json({
        success: false,
        message: "This guest add-on is no longer active. Your payment will be refunded in full.",
      });
    }

    return res.json({ success: true, message: "Payment verified", bookingId: booking._id });
  } catch (err) {
    console.error("verifyGuestAddonPayment error:", err);
    return res.status(500).json({ success: false, message: "Payment verification failed" });
  }
};
