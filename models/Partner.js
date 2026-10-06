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

    selfieVerificationStatus: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
      default: "PENDING",
      index: true,
    },

    selfieRejectionReason: {
      type: String,
      default: "",
    },

    password: {
      type: String,
      required: true,
      select: false,
    },

    // Set when the password changes; login tokens issued before it are void.
    passwordChangedAt: {
      type: Date,
      default: null,
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
       SKILL TIER
       AC (set at signup / profile): 1 = Non-Technician (cleaning,
       installation help), 2 = Technician (gas, PCB, advanced repairs).
       Salon / self-care (admin-set): 1 = beautician, 2 = senior
       beautician. The assignment engine gates tier-2 services on this.
       Mehendi / other partners stay at the default 1 (never read for them).
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
       H3 GEOSPATIAL
       h3Cell: live GPS cell (res 7) — updated on every heartbeat, used for distance scoring
       h3ServiceCells: derived from serviceAreas pincodes — best-effort
       assignedHubId: admin-assigned Hub (Urban-Company-style) — used for assignment matching
    ===================== */
    h3Cell: {
      type: String,
      default: null,
      index: true,
    },

    h3ServiceCells: {
      type: [String],
      default: [],
      index: true,
    },

    assignedHubId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hub",
      default: null,
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

    // Last time the partner's app called the API (any authenticated request;
    // partnerAuth writes it at most every few minutes). Drives the inactivity
    // pause below.
    lastActiveAt: {
      type: Date,
      default: null,
    },

    // Set when the partner has gone quiet: no app use for a few days
    // (pauseInactivePartners cron) or Firebase reported the app removed (dead
    // push token). While set they get no NEW jobs; their next app use clears it
    // automatically (partnerAuth).
    inactivePausedAt: {
      type: Date,
      default: null,
    },

    inactivePauseReason: {
      type: String,
      default: "",
    },

    // First time this partner's app reported a job as seen. Only partners on an
    // app build that sends that signal get the "job not seen yet" check —
    // older builds would otherwise look like they never see anything.
    seenSignalAt: {
      type: Date,
      default: null,
    },

    // Local day keys (YYYY-MM-DD) of the last job summaries sent, so each one
    // goes out at most once per day.
    eveningSummaryFor: {
      type: String,
      default: "",
    },

    morningSummaryFor: {
      type: String,
      default: "",
    },

    /* =====================
       FAIRNESS ENGINE
    ===================== */
    // Average of the partner's customer ratings (5 until the first one), kept
    // with totalReviews by services/rating.service.js.
    rating: {
      type: Number,
      default: 5,
      min: 0,
      max: 5,
    },

    totalReviews: {
      type: Number,
      default: 0,
      min: 0,
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

    // Daily cancel limit tracking (1 cancellation allowed per calendar day)
    dailyCancelCount: {
      type: Number,
      default: 0,
    },

    lastDailyCancelDate: {
      type: String, // YYYY-MM-DD
      default: null,
    },

    // Set when partner is auto-suspended (>= 5 weekly cancellations or admin action).
    // Assignment engine excludes partners where suspendedUntil > now. A strike
    // suspension only pauses NEW jobs (login, current jobs and withdrawals keep
    // working) and liftExpiredSuspensions ends it once this date passes.
    suspendedUntil: {
      type: Date,
      default: null,
    },

    // Free early releases: giving a job back FREE_RELEASE_MIN_HOURS+ before its
    // start costs no strike, up to FREE_RELEASES_PER_WEEK per rolling week.
    freeReleaseCount: {
      type: Number,
      default: 0,
    },

    freeReleaseWeekStart: {
      type: Date,
      default: null,
    },

    // Quality counters — increment on no-show / late-accept events.
    // Used by ops dashboard for proactive partner review AND by the
    // reliability component of the assignment score (scoreReliability).
    noShowCount: {
      type: Number,
      default: 0,
    },

    lateAcceptanceCount: {
      type: Number,
      default: 0,
    },

    /* =====================
       BEHAVIOURAL STATS (LEARNED RELIABILITY)
       Drive the acceptance-rate half of scoreReliability so the engine
       stops offering jobs to partners who habitually ignore them, and
       stops burning the 5-attempt reassignment budget on them.

       Tracked for the PRIMARY partner only (the one gated on ACK and the
       one reassignment revolves around). assignedCount advances on every
       soft-assignment; acceptedCount advances on accept (auto-accept
       counts as an immediate accept at assignment time). The gap between
       them — rejects and ACK timeouts — is exactly the unreliability we
       want to price in, so no separate reject counter is needed.
    ===================== */
    assignedCount: {
      type: Number,
      default: 0,
    },

    acceptedCount: {
      type: Number,
      default: 0,
    },

    // Average ACK response time = ackTotalSeconds / ackSampleCount.
    // Informational for now (surfaced to ops / the weight-shadow report);
    // not yet a live scoring input.
    ackTotalSeconds: {
      type: Number,
      default: 0,
    },

    ackSampleCount: {
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

    // Whole calendar days the partner has blocked off (e.g. a baker taking a
    // day off). Distinct from busySlots (per-slot, tied to actual bookings) —
    // these are self-declared and checked against scheduledDate, not time.
    unavailableDates: {
      type: [Date],
      default: [],
    },

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
  // A changed password ends every existing session (partnerAuth / the socket
  // room join reject tokens issued before this). Back-dated a second because
  // JWT iat is in whole seconds — the login right after a reset must pass.
  if (!this.isNew) this.passwordChangedAt = new Date(Date.now() - 1000);
  next();
});

module.exports = mongoose.model("Partner", partnerSchema);
