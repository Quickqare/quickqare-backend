const mongoose = require("mongoose");

/* Short, user-friendly booking reference shown on UI / SMS / support calls */
function generateBookingNumber() {
  const year = String(new Date().getFullYear()).slice(-2);
  const ts = Date.now().toString(36).slice(-5).toUpperCase();
  const rnd = Math.random().toString(36).slice(2, 4).toUpperCase();
  return `QQ${year}${ts}${rnd}`;
}

const bookingSchema = new mongoose.Schema(
  {
    /* ======================
       USER-FACING REFERENCE
    ====================== */
    bookingNumber: {
      type: String,
      unique: true,
      sparse: true, // allow existing rows without one
      index: true,
    },

    /* ======================
       USER & PARTNER
    ====================== */
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    partner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Partner",
      default: null,
    },

    // Team members beyond the primary (mehendi multi-artist, AC multi-unit).
    // Previously written via { strict: false } hack — declaring it properly here.
    additionalPartners: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Partner",
      },
    ],

    /* ======================
       SERVICES (PRODUCTION CART SYSTEM)
       Supports multiple services
    ====================== */

    // New multi-service support (cart system)
    services: [
      {
        serviceId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Service",
        },

        // Freeze service details at booking time
        name: String,
        price: Number,
        lineTotal: Number,
        pricingRuleKey: String,

        quantity: {
          type: Number,
          default: 1,
        },

        // For analytics + assignment + UI
        category: String,
        subCategory: String,
      },
    ],

    /* ======================
       PRIMARY SERVICE
       Used for partner assignment engine
       (important when multiple services exist)
    ====================== */
    primaryService: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
    },

    /* ======================
       BACKWARD COMPATIBILITY
       Old single-service system still works
       (DO NOT REMOVE)
    ====================== */

    // High level category (UI / analytics)
    serviceCategory: {
      type: String,
      lowercase: true,
    },

    // Exact service for old booking system
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
    },

    /* ======================
       PRICING (SOURCE OF TRUTH)
    ====================== */
    baseAmount: {
      type: Number,
      required: true,
    },

    discountAmount: {
      type: Number,
      default: 0,
    },

    couponCode: {
      type: String,
      default: null,
      trim: true,
    },

    couponId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      default: null,
    },

    couponDiscountAmount: {
      type: Number,
      default: 0,
    },

    gstAmount: {
      type: Number,
      default: 0,
    },

    totalAmount: {
      type: Number,
      required: true,
    },

    /* ======================
       SLOT
    ====================== */
    scheduledDate: {
      type: Date,
      required: true,
    },

    scheduledTime: {
      type: String,
      required: true,
    },

    scheduledStartAt: {
      type: Date,
      default: null,
    },

    scheduledEndAt: {
      type: Date,
      default: null,
    },

    estimatedDurationMinutes: {
      type: Number,
      default: 60,
      min: 1,
    },

    /* ======================
       LOCATION
    ====================== */

    // Geo location
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number], // [lng, lat]
        required: true,
      },
    },

    // Territory control
    pincode: {
      type: String,
      required: true,
    },

    address: {
      type: String,
      default: "",
      trim: true,
    },

    /* ======================
       PAYMENT
    ====================== */
    payment: {
      razorpay_payment_id: {
        type: String,
        default: null,
      },
      razorpay_order_id: {
        type: String,
        default: null,
      },
      razorpay_signature: {
        type: String,
        default: null,
      },
      status: {
        type: String,
        enum: ["PENDING", "PAID", "FAILED"],
        default: "PENDING",
      },
    },

    /* ======================
       ASSIGNMENT ENGINE
    ====================== */

    // 1 = primary pincode, 2 = extended
    assignmentStage: {
      type: Number,
      default: 1,
    },

    // Track rejected/cancelled partners
    rejectedPartners: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Partner",
      },
    ],

    teamAllocations: [
      {
        partnerId: { type: mongoose.Schema.Types.ObjectId, ref: "Partner" },
        assignedMinutes: Number,
        payoutRatio: Number,
        isPrimary: Boolean,
        status: { type: String, enum: ["ASSIGNED", "IN_PROGRESS", "COMPLETED"], default: "ASSIGNED" },
        completedAt: Date,
      }
    ],

    /* ======================
       BOOKING STATUS
    ====================== */
    status: {
      type: String,
      enum: [
        "PENDING_PAYMENT",
        "PENDING_ASSIGNMENT",
        "QUEUED",
        "SEARCHING",
        "ASSIGNING_LOCK", // brief atomic lock during assignBooking
        "ASSIGNED",
        "CONFIRMED",
        "NO_PARTNER_AVAILABLE",
        "PARTNER_ACCEPTED",
        "ON_THE_WAY",
        "ARRIVED",
        "IN_PROGRESS",
        "COMPLETED",
        "CANCELLED",
      ],
      default: "PENDING_PAYMENT",
    },

    cancelledBy: {
      type: String,
      enum: ["user", "partner", "system"],
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    cancelReason: {
      type: String,
      default: "",
      trim: true,
    },

    /* ======================
       REFUND (for user cancels)
    ====================== */
    refundAmount: {
      type: Number,
      default: 0,
    },

    refundStatus: {
      type: String,
      enum: ["NONE", "PENDING", "PROCESSED", "FAILED"],
      default: "NONE",
    },

    refundProcessedAt: {
      type: Date,
      default: null,
    },

    /* ======================
       ARRIVAL TRACKING
    ====================== */
    estimatedArrivalAt: {
      type: Date,
      default: null,
    },

    arrivedAt: {
      type: Date,
      default: null,
    },

    /* ======================
       POST-COMPLETION
    ====================== */
    requiresRating: {
      type: Boolean,
      default: false,
    },

    ratingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Rating",
      default: null,
    },

    standbyPartners: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Partner",
      },
    ],

    lockedUntil: {
      type: Date,
      default: null,
    },

    // Set when partner sends acknowledgeJob or acceptJob socket event.
    // handleAckTimeout checks this instead of an in-memory Set so restarts don't cause false reassignments.
    ackReceivedAt: {
      type: Date,
      default: null,
    },

    lockedCapacityMinutes: {
      type: Number,
      default: 0,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    partnerSettlement: {
      grossAmount: {
        type: Number,
        default: 0,
      },
      commissionAmount: {
        type: Number,
        default: 0,
      },
      partnerEarningAmount: {
        type: Number,
        default: 0,
      },
      status: {
        type: String,
        enum: ["UNSETTLED", "AVAILABLE", "PAID"],
        default: "UNSETTLED",
      },
      settledAt: {
        type: Date,
        default: null,
      },
      paidOutAt: {
        type: Date,
        default: null,
      },
    },

    assignmentAudit: {
      type: [
        {
          stage: Number,
          event: String,
          searchedPincodes: [String],
          selectedPartnerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Partner",
            default: null,
          },
          notes: String,
          candidates: [
            {
              partnerId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "Partner",
              },
              score: Number,
              skillMatchLevel: Number,
              distanceMeters: Number,
              activeJobs: Number,
              rating: Number,
              fairnessScore: Number,
              reliabilityScore: Number,
              inPrimaryPincode: Boolean,
              autoAccept: Boolean,
            },
          ],
          createdAt: {
            type: Date,
            default: Date.now,
          },
        },
      ],
      default: [],
    },

    isPaidToPartner: {
      type: Boolean,
      default: false,
    },

    /* ======================
       PARTNER ESTIMATE (ITEMIZED CART)
       Partner submits extra items on-site;
       customer approves before additional charges apply.
    ====================== */
    estimateItems: [
      {
        serviceId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Service",
        },
        name: String,
        price: Number,
        quantity: {
          type: Number,
          default: 1,
        },
        lineTotal: Number,
      },
    ],

    estimateTotal: {
      type: Number,
      default: 0,
    },

    estimateStatus: {
      type: String,
      enum: ["none", "pending", "approved", "rejected"],
      default: "none",
    },

    estimateSubmittedAt: {
      type: Date,
      default: null,
    },

    estimateApprovedAt: {
      type: Date,
      default: null,
    },

    estimateRejectedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

/* ======================
   GEO INDEX
====================== */
bookingSchema.index({ location: "2dsphere" });

/* ======================
   PRE-SAVE: AUTO-GENERATE BOOKING NUMBER
   Retries on the rare collision (uniqueness backed by index).
====================== */
bookingSchema.pre("save", async function (next) {
  if (this.bookingNumber) return next();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateBookingNumber();
    const exists = await this.constructor.findOne({ bookingNumber: candidate }).lean();
    if (!exists) {
      this.bookingNumber = candidate;
      return next();
    }
  }
  // Extremely unlikely fallback — collisions in 5 attempts at this entropy
  this.bookingNumber = `${generateBookingNumber()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  next();
});

module.exports = mongoose.model("Booking", bookingSchema);
