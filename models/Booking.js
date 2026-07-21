const mongoose = require("mongoose");
const crypto = require("crypto");

// Random uppercase [A-Z0-9] string using a CSPRNG (crypto.randomInt), not
// Math.random — used for the booking reference suffix and, more importantly,
// the service start code, which gates starting a job and must be unguessable.
const RAND_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function randomAlphaNum(length) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += RAND_ALPHABET[crypto.randomInt(RAND_ALPHABET.length)];
  }
  return out;
}

/* Short, user-friendly booking reference shown on UI / SMS / support calls */
function generateBookingNumber() {
  const year = String(new Date().getFullYear()).slice(-2);
  const ts = Date.now().toString(36).slice(-5).toUpperCase();
  const rnd = randomAlphaNum(2);
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

    // How the booking was created. "partner_onspot" = a guest-mehendi add-on a
    // partner added at the venue during an in-progress booking (pre-assigned to
    // that same partner, needs customer approval + payment). Everything else is
    // the normal customer-initiated flow.
    origin: {
      type: String,
      enum: ["customer", "partner_onspot"],
      default: "customer",
    },

    // For a partner_onspot add-on: the in-progress booking it was added onto.
    // Lets the apps group the two orders from the same visit together.
    parentBooking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
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

    // AC helpers the assigned technician brings for manpower (lifting, drilling).
    // A frozen snapshot — helpers never go through the assignment engine and
    // cannot accept/reject the job; the technician picks them post-assignment.
    helpers: [
      {
        partnerId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Partner",
        },
        name: String,
        phone: String,
        addedAt: {
          type: Date,
          default: Date.now,
        },
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

        // Per-order customization snapshot (cakes) — resolved and priced
        // server-side at booking time; addon prices frozen here.
        options: {
          flavour: String,
          weight: String, // e.g. "1 kg" — resolved against Service.customization.weights
          tiers: Number, // 1 | 2
          eggless: { type: Boolean, default: false },
          addons: [
            {
              name: String,
              price: Number,
            },
          ],
          nameOnCake: { type: String, trim: true, maxlength: 40 },
          // Customer-uploaded "make it look like this" photo — display only,
          // not validated against any config (unlike flavour/weight/addons).
          referencePhotoUrl: { type: String, trim: true },
        },
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

    platformFeeAmount: {
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
    h3Cell: {
      type: String,
      default: null,
      index: true,
    },

    pincode: {
      type: String,
      required: true,
    },

    address: {
      type: String,
      default: "",
      trim: true,
    },

    houseDetails: {
      type: String,
      default: null,
      trim: true,
    },

    landmark: {
      type: String,
      default: null,
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
      // Razorpay refund id (rfnd_...) from the instant auto-refund path.
      // Lets back office reconcile against the Razorpay dashboard and proves
      // a refund was already issued if the PROCESSED status write was lost.
      razorpay_refund_id: {
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
        // Partner-created guest mehendi add-on, waiting for the customer to
        // approve & pay. Only ever used by origin === "partner_onspot" bookings.
        "PENDING_APPROVAL",
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
        "NEEDS_RESCHEDULING",
      ],
      default: "PENDING_PAYMENT",
    },

    cancelledBy: {
      type: String,
      // "admin" covers force-cancel / manual cancel from the admin panel.
      enum: ["user", "partner", "system", "admin"],
      default: null,
    },

    /* ======================
       SERVICE START CODE
       4-digit code shown only in the customer app; the partner must enter it
       to move the booking to IN_PROGRESS. Delivered in-app — zero SMS cost.
       Never expose via partner-facing payloads (toPartnerJobPayload / socket).
    ====================== */
    serviceStartCode: {
      type: String,
      default: null,
    },

    // Wrong-code attempts by the partner; locked after 5 (support unlocks).
    startCodeAttempts: {
      type: Number,
      default: 0,
    },

    /* ======================
       JOB-SPOT SELFIE (admin-gated via jobSelfieVerificationEnabled)
       Live selfie the partner uploads at the customer's location before
       starting. Admin reviews it side-by-side with the onboarding selfie.
    ====================== */
    startSelfieUrl: {
      type: String,
      default: "",
      trim: true,
    },

    startSelfieAt: {
      type: Date,
      default: null,
    },

    // GPS captured at selfie time (plain lat/lng — no geo queries needed).
    startSelfieLocation: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
    },

    // Haversine distance from the booking location; null when GPS unavailable.
    startSelfieDistanceMeters: {
      type: Number,
      default: null,
    },

    // True when the selfie was taken too far from the customer's address —
    // surfaces in the admin booking detail for review. Never blocks the job.
    startSelfieFlagged: {
      type: Boolean,
      default: false,
    },

    /* ======================
       RESCHEDULE
    ====================== */
    rescheduleReason: { type: String, trim: true, default: null },
    rescheduleRequestedAt: { type: Date, default: null },
    rescheduledFromDate: { type: String, default: null },
    rescheduledFromTime: { type: String, default: null },

    cancelledAt: {
      type: Date,
      default: null,
    },

    // Each entry records a partner who cancelled this booking (before reassignment)
    partnerCancellations: {
      type: [
        {
          partner:     { type: mongoose.Schema.Types.ObjectId, ref: "Partner" },
          reason:      { type: String, trim: true },
          cancelledAt: { type: Date },
          _id:         false,
        },
      ],
      default: [],
    },

    // Set when a partner CANCELS a job we're re-searching for. If reassignment then
    // exhausts (no replacement found), escalation auto-cancels with a full refund —
    // the platform absorbs the failure. Distinct from a customer-initiated reschedule
    // (which clears this) and from an initial booking that simply can't be filled
    // (which stays false and goes to ops). See escalation.service.js.
    autoRefundIfUnassigned: {
      type: Boolean,
      default: false,
    },

    cancelReason: {
      type: String,
      default: "",
      trim: true,
    },

    // Snapshot of cancellation tiers at booking creation time.
    // Protects customer from retroactive policy changes by admin.
    // Uses most lenient tiers across all booked services.
    cancellationTiersSnapshot: {
      type: [
        {
          minHoursBefore: { type: Number },
          refundPercent:  { type: Number },
        },
      ],
      default: [],
    },

    // BEFORE_SERVICE (default): refund from cancellationTiersSnapshot, keyed
    // on hours remaining until the service. SINCE_BOOKING (cakes): refund from
    // sinceBookingTiersSnapshot, keyed on hours elapsed since booking creation.
    cancellationPolicyTypeSnapshot: {
      type: String,
      enum: ["BEFORE_SERVICE", "SINCE_BOOKING"],
      default: "BEFORE_SERVICE",
    },

    // Ascending by maxHoursAfterBooking; first matching tier wins.
    sinceBookingTiersSnapshot: {
      type: [
        {
          maxHoursAfterBooking: { type: Number },
          refundPercent:        { type: Number },
        },
      ],
      default: [],
    },

    // Grace-period free-cancel deadline, computed at creation from the
    // services' cancellationGrace config (orders placed with little notice
    // get a short window to cancel at 100%). Null = no grace applies.
    // Cancelling at or before this instant refunds 100% regardless of the
    // tier the cancel would otherwise land in.
    freeCancelUntil: {
      type: Date,
      default: null,
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

    // Lifecycle timestamps for SLA tracking. These were previously written by
    // the partner lifecycle endpoints but silently DROPPED by strict mode
    // because the fields didn't exist in the schema.
    onTheWayAt: {
      type: Date,
      default: null,
    },

    inProgressAt: {
      type: Date,
      default: null,
    },

    arrivedAt: {
      type: Date,
      default: null,
    },

    // Set by the reminder cron once the pre-job reminder push has gone out,
    // so the partner / helpers / customer aren't reminded repeatedly.
    preJobReminderSentAt: {
      type: Date,
      default: null,
    },

    // Set once the day-before "cake order due tomorrow" push has gone out to
    // the assigned baker. Separate from preJobReminderSentAt, which fires only
    // ~30 min before service — cake orders need an earlier heads-up.
    cakeReminderSentAt: {
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

    // When the current partner was attached (reset on every reassignment).
    // Anchors the ACK deadline for ADVANCE assignments (start >3h away, e.g.
    // cake orders assigned at payment): the partner may legitimately be
    // offline, so instead of the 2-minute socket timer they get
    // ADVANCE_ACK_WINDOW_MS from this timestamp to acknowledge — enforced by
    // the enforceAdvanceAckDeadlines cron, restart-safe by construction.
    assignedAt: {
      type: Date,
      default: null,
    },

    lockedCapacityMinutes: {
      type: Number,
      default: 0,
    },

    slotLockId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SlotLock",
      default: null,
    },

    slotReservationUnits: {
      type: Number,
      default: 0,
    },

    slotReservationExpiresAt: {
      type: Date,
      default: null,
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
              // Per-component scores — the full breakdown the weight-shadow
              // report replays to recompute rankings under alternate weights.
              fairnessScore: Number,
              earningsScore: Number,
              distanceScore: Number,
              skillScore: Number,
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

    /* ======================
       ESTIMATE PAYMENT
       Razorpay collection for an approved on-site estimate. A separate order
       from the main booking payment (razorpay_order_id here never collides with
       payment.razorpay_order_id — the webhook checks both). Amounts are frozen
       at order-creation time so the charge stays reconcilable even if pricing
       settings change later. Settlement includes the estimate only when this
       reaches PAID.
    ====================== */
    estimatePayment: {
      razorpay_order_id: {
        type: String,
        default: null,
      },
      razorpay_payment_id: {
        type: String,
        default: null,
      },
      razorpay_signature: {
        type: String,
        default: null,
      },
      status: {
        type: String,
        enum: ["NONE", "PENDING", "PAID", "FAILED"],
        default: "NONE",
      },
      paidAt: {
        type: Date,
        default: null,
      },
      baseAmount: {
        type: Number,
        default: 0,
      },
      platformFeeAmount: {
        type: Number,
        default: 0,
      },
      gstAmount: {
        type: Number,
        default: 0,
      },
      totalAmount: {
        type: Number,
        default: 0,
      },
    },

    // Tracks whether wallet credits ran after COMPLETED status was set.
    // "pending"  → booking marked COMPLETED but credits not yet confirmed
    // "credited" → all partner wallet credits succeeded
    // "failed"   → credit retry exhausted; needs manual admin intervention
    // Absent     → pre-feature booking (ignore in cron)
    payoutStatus: {
      type: String,
      enum: ["pending", "credited", "failed"],
    },

    // Failed wallet-credit attempts by the retry cron. "failed" is only set
    // once this reaches PAYOUT_MAX_RETRIES — a single transient error must not
    // permanently strand the partner's earnings behind manual intervention.
    payoutRetryCount: {
      type: Number,
      default: 0,
    },

    /* ======================
       PARTNER ON-SITE ISSUE REPORTS
       Lightweight audit trail when a partner flags a problem at the door
       (e.g. customer not available / asked to come later). Purely informational
       for ops — does NOT change booking status, fees, or refunds. A human in the
       admin panel decides what to do. See controller reportBookingIssue.
    ====================== */
    partnerReports: [
      {
        partner: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Partner",
        },
        issueType: String,
        note: String,
        statusAtReport: String,
        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  { timestamps: true }
);

/* ======================
   GEO INDEX
====================== */
bookingSchema.index({ location: "2dsphere" });

/* ======================
   QUERY INDEXES
   Without these, the hottest Booking queries are full collection scans —
   invisible at launch volume, but every one degrades linearly as the
   collection grows toward 100k+ rows.
====================== */

// Per-user concurrent-unpaid cap in createBooking — runs on EVERY booking
// create ({ user, status: "PENDING_PAYMENT", lockedUntil: { $gt: now } }).
// Prefix { user, status } also serves any per-user status-filtered lookup.
bookingSchema.index({ user: 1, status: 1, lockedUntil: 1 });

// Customer "My Bookings" list: equality on user + sort { createdAt: -1 }
// (getMyBookings). The index walks the user's rows already in sort order, so
// pagination never re-sorts.
bookingSchema.index({ user: 1, createdAt: -1 });

// Partner job lists and getBlockingWindowsByPartner's $or branches
// ({ partner|additionalPartners: { $in }, status: { $in }, scheduledDate:
// range }) — run on every slot listing AND every assignment attempt.
// additionalPartners is an array → multikey index.
bookingSchema.index({ partner: 1, status: 1, scheduledDate: 1 });
bookingSchema.index({ additionalPartners: 1, status: 1, scheduledDate: 1 });

// Status-led periodic scans: cancelStaleBookings, dispatchQueuedBookings,
// detectNoShowPartners, reminder crons, and resumePendingAckTimeouts all lead
// with an equality/$in on status (± a time bound). The status prefix alone
// cuts each scan from the whole collection to just the rows in that status.
bookingSchema.index({ status: 1, scheduledStartAt: 1 });

/* ======================
   PRE-SAVE: AUTO-GENERATE BOOKING NUMBER
   Retries on the rare collision (uniqueness backed by index).
====================== */
bookingSchema.pre("save", async function (next) {
  if (!this.serviceStartCode) {
    // CSPRNG 4-digit code (1000–9999) — the partner must enter it to start the
    // job, so it must not be predictable from Math.random's weak PRNG.
    this.serviceStartCode = String(crypto.randomInt(1000, 10000));
  }
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
  this.bookingNumber = `${generateBookingNumber()}${randomAlphaNum(3)}`;
  next();
});

module.exports = mongoose.model("Booking", bookingSchema);
