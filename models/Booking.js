const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
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
        "ASSIGNED",
        "CONFIRMED",
        "NO_PARTNER_AVAILABLE",
        "PARTNER_ACCEPTED",
        "ON_THE_WAY",
        "IN_PROGRESS",
        "COMPLETED",
        "CANCELLED",
      ],
      default: "PENDING_PAYMENT",
    },

    cancelledBy: {
      type: String,
      enum: ["user", "partner"],
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

module.exports = mongoose.model("Booking", bookingSchema);
