const mongoose = require("mongoose");
const PartnerWallet = require("./PartnerWallet");
const bcrypt = require("bcrypt");

/* =====================================================
   PARTNER SCHEMA (PRODUCTION READY)
===================================================== */
const partnerSchema = new mongoose.Schema(
  {
    /* =====================
       BASIC DETAILS
    ===================== */
    name: {
      type: String,
      required: true,
      trim: true,
    },

    phone: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    email: {
      type: String,
      default: "",
      trim: true,
    },

    gender: {
      type: String,
      enum: ["MALE", "FEMALE", "OTHER", ""],
      default: "",
      trim: true,
    },

    dateOfBirth: {
      type: Date,
      default: null,
    },

    selfieUrl: {
      type: String,
      default: "",
      trim: true,
    },

    password: {
      type: String,
      required: true,
      select: false,
    },

    /* =====================
       ADMIN CONTROL
    ===================== */
    isBlocked: {
      type: Boolean,
      default: false,
    },

    approvalStatus: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
      default: "PENDING",
      index: true,
    },

    verificationStatus: {
      type: String,
      enum: ["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"],
      default: "UNVERIFIED",
      index: true,
    },

    commissionPercent: {
      type: Number,
      default: 20,
      min: 0,
      max: 100,
    },

    /* =====================
       PARTNER PLAN
    ===================== */
    plan: {
      type: String,
      enum: ["basic", "pro", "elite"],
      default: "basic",
    },

    subscriptionActive: {
      type: Boolean,
      default: false,
    },

    /* =====================
       SERVICE CATEGORIES
       (Future matching optimization)
    ===================== */
    serviceCategories: {
      type: [String],
      default: [],
    },

    /* =====================
       AC SKILL TIER
       1 = Non-Technician (cleaning, installation help)
       2 = Technician (gas, PCB, advanced repairs)
       The assignment engine gates AC Level 2+ jobs on this.
       Mehendi / non-AC partners stay at the default 1 (never read for them).
    ===================== */
    skillTier: {
      type: Number,
      enum: [1, 2],
      default: 1,
    },

    /* =====================
       MEHENDI SPECIALIZATIONS
       Subcategory names the partner can perform.
       Populated at signup when serviceCategory = "Mehendi".
    ===================== */
    mehendiSpecializations: {
      type: [String],
      default: [],
    },

    /* =====================
       SERVICES (MULTI SERVICE SUPPORT)
       Stores capability snapshot
    ===================== */
    services: [
      {
        serviceId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Service",
        },

        name: String,
        category: String,
        subCategory: String,

        isActive: {
          type: Boolean,
          default: true,
        },
      },
    ],

    /* =====================
       SERVICE TERRITORY
    ===================== */
    serviceAreas: {
      type: [String],
      default: [],
      index: true,
    },

    /* =====================
       AVAILABILITY
    ===================== */
    isOnline: {
      type: Boolean,
      default: false,
    },

    isAvailable: {
      type: Boolean,
      default: true,
    },

    autoAccept: {
      type: Boolean,
      default: true,
    },

    lastOnlineAt: Date,

    /* =====================
       FAIRNESS ENGINE
    ===================== */
    rating: {
      type: Number,
      default: 5,
      min: 0,
      max: 5,
    },

    activeJobs: {
      type: Number,
      default: 0,
      min: 0,
    },

    maxJobsLimit: {
      type: Number,
      default: 3,
    },

    lastAssignedAt: Date,

    /* =====================
       CANCELLATION CONTROL
    ===================== */
    weeklyCancelCount: {
      type: Number,
      default: 0,
    },

    lastCancelReset: {
      type: Date,
      default: Date.now,
    },

    // Set when partner is auto-suspended (>= 5 weekly cancellations or admin action).
    // Assignment engine excludes partners where suspendedUntil > now.
    suspendedUntil: {
      type: Date,
      default: null,
    },

    // Quality counters — increment on no-show / late-accept events.
    // Used by ops dashboard for proactive partner review.
    noShowCount: {
      type: Number,
      default: 0,
    },

    lateAcceptanceCount: {
      type: Number,
      default: 0,
    },

    /* =====================
       AVAILABILITY CALENDAR
    ===================== */
    busySlots: [
      {
        date: {
          type: Date,
          required: true,
        },
        time: {
          type: String,
          required: true,
        },
      },
    ],

    /* =====================
       LOCATION (GEO MATCHING)
    ===================== */
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number], // [lng, lat]
        default: [0, 0],
      },
    },

    currentPincode: {
      type: String,
      default: "",
      index: true,
    },

    currentAddress: {
      type: String,
      default: "",
    },

    lastLocationAt: {
      type: Date,
      default: null,
    },

    lastGeocodedAt: {
      type: Date,
      default: null,
    },

    /* =====================
       BANK DETAILS
    ===================== */
    bankDetails: {
      accountHolderName: String,
      accountNumber: String,
      ifsc: String,
      bankName: String,
    },

    /* =====================
       PUSH NOTIFICATIONS
    ===================== */
    fcmToken: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

/* =====================
   GEO INDEX
===================== */
partnerSchema.index({ location: "2dsphere" });

/* =====================
   ELIGIBILITY QUERY INDEXES
   Covers findEligiblePartnersForBooking compound filters
===================== */
partnerSchema.index({ isBlocked: 1, approvalStatus: 1, isOnline: 1 });
partnerSchema.index({ isBlocked: 1, approvalStatus: 1, serviceAreas: 1 });

/* =====================
   AUTO CREATE WALLET
===================== */
partnerSchema.post("save", async function (doc) {
  try {
    const existingWallet = await PartnerWallet.findOne({
      partnerId: doc._id,
    });

    if (!existingWallet) {
      await PartnerWallet.create({
        partnerId: doc._id,
        balance: 0,
        totalEarnings: 0,
        totalWithdrawn: 0,
      });
    }
  } catch (err) {
    console.error("Wallet creation error:", err.message);
  }
});

/* =====================
   ACCOUNT DELETION
===================== */
partnerSchema.add({
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  deleteReason: { type: String, default: "" },
});

/* =====================
   PASSWORD HASHING
===================== */
partnerSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();

  this.password = await bcrypt.hash(this.password, 10);
  next();
});

module.exports = mongoose.model("Partner", partnerSchema);
