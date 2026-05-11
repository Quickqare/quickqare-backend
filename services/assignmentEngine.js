const Booking = require("../models/Booking");
const User = require("../models/User");
const {
  findEligiblePartnersForBooking,
  syncPartnerOperationalState,
  buildDateTime,
  AC_CATEGORY_SLUGS,
  AC_MAX_CAPACITY_MINUTES,
} = require("./scheduling_service");
const { resolveZoneForPincode, getZoneCoveragePincodes } = require("./zone.service");
const { escalateUnassignedBooking } = require("./escalation.service");

/*
=====================================================
GET PINCODES BY ASSIGNMENT STAGE
=====================================================
*/
async function getPincodesForStage(booking) {
  if (booking.assignmentStage === 1) {
    return [booking.pincode];
  }

  const zone = await resolveZoneForPincode(booking.pincode);
  if (!zone || zone.isActive === false) return [booking.pincode];
  if (zone.partnerAppEnabled === false) return [];

  if (booking.assignmentStage === 2 && zone.nearbyPincodes?.length) {
    return zone.nearbyPincodes;
  }

  if (booking.assignmentStage === 3 && zone.extendedPincodes?.length) {
    return zone.extendedPincodes;
  }

  const coverage = getZoneCoveragePincodes(zone);
  return coverage.length ? coverage : [booking.pincode];
}

/*
=====================================================
DETECT AC BOOKING
AC bookings use different bin capacity and skill
weighting than general / mehendi bookings.
=====================================================
*/
function isACBooking(booking) {
  const cat = String(booking.serviceCategory || "").toLowerCase();
  return AC_CATEGORY_SLUGS.some((slug) => cat.includes(slug));
}

/*
=====================================================
COMPUTE REQUIRED PARTNERS (TASK BIN PACKING)
Handles both Mehendi multi-artist logic and AC
multi-unit technician logic through a unified FFD
(First-Fit Decreasing) packer.
=====================================================
*/
async function computeRequiredPartners(booking) {
  // ── Shared constants ──────────────────────────────────────────────
  const MEHENDI_MAX_CAPACITY = 420; // 7 h per guest mehendi artist
  const MAX_CAPACITY = isACBooking(booking)
    ? AC_MAX_CAPACITY_MINUTES        // 360 min for AC (equipment overhead)
    : MEHENDI_MAX_CAPACITY;

  let dedicatedPartners = 0;        // bridal artists (mehendi) / lead tech (AC multi-unit)
  const dedicatedMinutes = [];
  const handTasks = [];
  const addonFeetTasks = [];
  const independentTasks = [];

  if (!Array.isArray(booking.services) || !booking.services.length) {
    return { requiredCount: 1, dedicatedMinutes: [], taskBins: [0] };
  }

  const Service = require("../models/service.model");
  const serviceIds = booking.services.map((s) => s.serviceId).filter(Boolean);
  const servicesData = await Service.find({ _id: { $in: serviceIds } }).lean();
  const serviceMap = new Map(servicesData.map((s) => [String(s._id), s]));

  // ── AC multi-unit packing ─────────────────────────────────────────
  if (isACBooking(booking)) {
    booking.services.forEach((s) => {
      const quantity = Math.max(Number(s.quantity || 1), 1);
      const serviceRef = serviceMap.get(String(s.serviceId));
      const duration = serviceRef ? Number(serviceRef.duration || 90) : 90;

      // Each AC unit is an independent task block (one tech per unit baseline)
      for (let i = 0; i < quantity; i++) {
        handTasks.push(duration);
      }
    });
  } else {
    // ── Mehendi multi-artist packing ──────────────────────────────────
    const ADDON_FEET_NAMES = ["basic feet", "feet", "ankle", "above ankle"];
    const INDEPENDENT_FEET_NAMES = ["mid leg", "below knee", "mehendi for guests"];

    booking.services.forEach((s) => {
      const cat = String(s.category || "").toLowerCase();
      const name = String(s.name || "").toLowerCase();
      const isMehendi = cat.includes("mehendi") || name.includes("mehendi");
      if (!isMehendi) return;

      const quantity = Math.max(Number(s.quantity || 1), 1);
      const serviceRef = serviceMap.get(String(s.serviceId));
      const duration = serviceRef ? Number(serviceRef.duration || 60) : 60;

      if (name.includes("bridal mehendi")) {
        // Phase 1: Dedicated bridal allocation — 1 bride = 2 dedicated artists
        dedicatedPartners += quantity * 2;
        for (let i = 0; i < quantity * 2; i++) {
          dedicatedMinutes.push(duration);
        }
      } else {
        for (let i = 0; i < quantity; i++) {
          if (ADDON_FEET_NAMES.some((addon) => name === addon)) {
            addonFeetTasks.push(duration);
          } else if (INDEPENDENT_FEET_NAMES.some((indep) => name === indep)) {
            independentTasks.push(duration);
          } else {
            handTasks.push(duration);
          }
        }
      }
    });
  }

  // Phase 2: Task block construction (pair hand + feet for mehendi)
  handTasks.sort((a, b) => b - a);
  addonFeetTasks.sort((a, b) => b - a);

  const taskBlocks = [];
  for (const feetDuration of addonFeetTasks) {
    if (handTasks.length > 0) {
      taskBlocks.push(handTasks.shift() + feetDuration);
    } else {
      taskBlocks.push(feetDuration);
    }
  }
  taskBlocks.push(...handTasks, ...independentTasks);

  // Phase 3 & 4: First-Fit Decreasing bin packing
  taskBlocks.sort((a, b) => b - a);
  const taskBins = [];

  for (const task of taskBlocks) {
    let placed = false;
    for (let i = 0; i < taskBins.length; i++) {
      if (taskBins[i] + task <= MAX_CAPACITY) {
        taskBins[i] += task;
        placed = true;
        break;
      }
    }
    if (!placed) taskBins.push(task);
  }

  // Phase 5: Total required
  const guestPartners = taskBins.length;
  const requiredCount = Math.max(dedicatedPartners + guestPartners, 1);

  return { requiredCount, dedicatedMinutes, taskBins };
}

/*
=====================================================
ASSIGN BOOKING
=====================================================
*/
async function assignBooking(bookingId, opts = {}) {
  try {
    // Self-heal: if a previous assignBooking crashed or was killed mid-run,
    // the booking will be stuck in ASSIGNING_LOCK forever. Reset locks older
    // than 60 seconds back to PENDING_ASSIGNMENT before trying to acquire.
    const lockExpiry = new Date(Date.now() - 60 * 1000);
    await Booking.updateOne(
      {
        _id: bookingId,
        status: "ASSIGNING_LOCK",
        updatedAt: { $lt: lockExpiry },
      },
      { $set: { status: "PENDING_ASSIGNMENT" } }
    );

    // Atomic lock — prevents two parallel assignment attempts from running together.
    const booking = await Booking.findOneAndUpdate(
      { _id: bookingId, partner: null, status: { $nin: ["ASSIGNING_LOCK", "COMPLETED", "CANCELLED"] } },
      { $set: { status: "ASSIGNING_LOCK" } },
      { new: true }
    );

    if (!booking) {
      return null;
    }

    const acBooking = isACBooking(booking);

    // For future bookings (scheduled more than 30 min from now) we don't require
    // partners to be online RIGHT NOW — they only need to be approved and available.
    // They will come online before the actual service. Requiring online=true for
    // next-day bookings means zero partners match and the booking hits NO_PARTNER_AVAILABLE.
    const scheduledStart = booking.scheduledStartAt
      ? new Date(booking.scheduledStartAt)
      : buildDateTime(booking.scheduledDate, booking.scheduledTime);
    const minutesToService = (scheduledStart.getTime() - Date.now()) / (1000 * 60);

    // Don't assign a booking whose service window has already passed.
    // A booking more than 60 minutes in the past is unserviceable — escalate immediately.
    if (minutesToService < -60) {
      booking.status = "NO_PARTNER_AVAILABLE";
      booking.assignmentAudit.push({
        stage: booking.assignmentStage || 1,
        event: "NO_PARTNER_AVAILABLE",
        searchedPincodes: [],
        notes: `Service window already passed (${Math.round(-minutesToService)} min ago) — cannot assign`,
        candidates: [],
      });
      await booking.save();
      await escalateUnassignedBooking(booking._id);
      return null;
    }

    const requireOnline = opts.requireOnline !== undefined
      ? opts.requireOnline
      : minutesToService <= 30; // only require online for imminent bookings

    for (let stage = booking.assignmentStage || 1; stage <= 3; stage += 1) {
      booking.assignmentStage = stage;
      await booking.save();

      const pincodesToSearch = await getPincodesForStage(booking);
      if (!pincodesToSearch.length) {
        booking.assignmentAudit.push({
          stage,
          event: "NO_PINCODES_TO_SEARCH",
          searchedPincodes: [],
          notes: "Zone expansion returned no searchable pincodes",
        });
        await booking.save();
        continue;
      }

      const rankedPartners = await findEligiblePartnersForBooking(
        booking,
        pincodesToSearch,
        { requireOnline }
      );

      if (!rankedPartners.length) {
        booking.assignmentAudit.push({
          stage,
          event: "NO_ELIGIBLE_PARTNERS",
          searchedPincodes: pincodesToSearch,
          notes: "No partner passed production eligibility and scoring filters",
          candidates: [],
        });
        await booking.save();
        continue;
      }

      // Compute how many partners this booking actually needs
      const { requiredCount, dedicatedMinutes, taskBins } =
        await computeRequiredPartners(booking);

      // Not enough eligible partners available for this stage — try the next wider zone.
      if (rankedPartners.length < requiredCount) {
        booking.assignmentAudit.push({
          stage,
          event: "INSUFFICIENT_PARTNERS",
          searchedPincodes: pincodesToSearch,
          notes: `Need ${requiredCount} partner(s), only ${rankedPartners.length} eligible in stage ${stage}`,
          candidates: rankedPartners.slice(0, 5).map((e) => ({ partnerId: e.partner._id, score: e.score })),
        });
        await booking.save();
        continue;
      }

      const selectedPartners = rankedPartners
        .slice(0, requiredCount)
        .map((r) => r.partner);
      const primaryPartner = selectedPartners[0];
      const additionalPartners = selectedPartners.slice(1);

      // Identify standby partners (up to 3 next best candidates)
      const standbyCandidates = rankedPartners
        .slice(requiredCount, requiredCount + 3)
        .map((r) => r.partner._id);

      // Build proportional workload + payout mapping.
      // The last partner absorbs the rounding remainder so the ratios sum to
      // exactly 1.0 — otherwise toFixed(4) leaves a few paise unallocated and
      // the customer's totalAmount never fully matches sum(partner earnings).
      const allWorkloads = [...dedicatedMinutes, ...taskBins].sort(
        (a, b) => b - a
      );
      const totalWorkloadMinutes = allWorkloads.reduce((a, b) => a + b, 0) || 1;

      let assignedRatioSum = 0;
      const teamAllocations = selectedPartners.map((p, index) => {
        const isLast = index === selectedPartners.length - 1;
        let payoutRatio;
        if (isLast) {
          payoutRatio = Number(Math.max(1 - assignedRatioSum, 0).toFixed(4));
        } else {
          payoutRatio = Number(
            ((allWorkloads[index] || 0) / totalWorkloadMinutes).toFixed(4)
          );
          assignedRatioSum = Number((assignedRatioSum + payoutRatio).toFixed(4));
        }
        return {
          partnerId: p._id,
          assignedMinutes: allWorkloads[index] || 0,
          payoutRatio,
          isPrimary: index === 0,
        };
      });

      const autoAccepted = Boolean(primaryPartner.autoAccept);
      const finalStatus = autoAccepted ? "CONFIRMED" : "ASSIGNED";

      booking.partner = primaryPartner._id;
      booking.teamAllocations = teamAllocations;
      booking.additionalPartners = additionalPartners.map((p) => p._id);
      booking.standbyPartners = standbyCandidates;

      booking.status = finalStatus;
      // Auto-accepted bookings don't need a manual ACK from the partner.
      // Mark ackReceivedAt now so the ACK timeout handler skips reassignment.
      if (autoAccepted) {
        booking.ackReceivedAt = new Date();
      }
      booking.assignmentAudit.push({
        stage,
        event: autoAccepted ? "CONFIRMED_AUTO" : "SOFT_ASSIGNED",
        searchedPincodes: pincodesToSearch,
        selectedPartnerId: primaryPartner._id,
        notes: `[${acBooking ? "AC" : "BEAUTY"}] Selected top-ranked partner${
          autoAccepted ? " with auto-accept enabled" : ""
        } — ${requiredCount} partner(s) required`,
        candidates: rankedPartners.slice(0, 10).map((entry) => ({
          partnerId: entry.partner._id,
          score: Number(entry.score || 0),
          skillMatchLevel: Number(entry.skillMatchLevel || 0),
          distanceMeters: Number.isFinite(entry.distanceMeters)
            ? Math.round(entry.distanceMeters)
            : null,
          activeJobs: Number(entry.activeJobs || 0),
          fairnessScore: Number(entry.fairnessScore || 0),
          earningsScore: Number(entry.earningsScore || 0),
          autoAccept: Boolean(entry.partner?.autoAccept),
        })),
      });
      await booking.save();

      // Schedule ACK timeout only for manual-accept bookings (ASSIGNED).
      // Auto-accepted bookings (CONFIRMED) already have ackReceivedAt set above —
      // no partner action required, so no timeout needed.
      if (!autoAccepted) {
        try {
          const { scheduleAckTimeout } = require("./ackTimeout.service");
          await scheduleAckTimeout(booking._id, primaryPartner._id);
        } catch (timeoutErr) {
          console.error("ACK timeout schedule error:", timeoutErr.message);
        }
      }

      // Update all assigned partners' state
      for (const teamPartner of selectedPartners) {
        teamPartner.activeJobs += 1;
        teamPartner.lastAssignedAt = new Date();
        teamPartner.busySlots = [
          ...(teamPartner.busySlots || []),
          { date: booking.scheduledDate, time: booking.scheduledTime },
        ];
        await teamPartner.save();
        await syncPartnerOperationalState(teamPartner._id);
      }

      // Emit Socket.io events to all assigned partners
      if (global.io) {
        const user = await User.findById(booking.user)
          .select("name phone")
          .lean();

        const firstServiceName =
          booking.services?.[0]?.name ||
          booking.serviceCategory ||
          "Service";

        const customerLongitude = Array.isArray(booking.location?.coordinates)
          ? Number(booking.location.coordinates[0])
          : null;

        const customerLatitude = Array.isArray(booking.location?.coordinates)
          ? Number(booking.location.coordinates[1])
          : null;

        const assignmentPayload = {
          id: booking._id?.toString(),
          bookingId: booking._id?.toString(),
          message: "New job assigned",
          serviceName: firstServiceName,
          serviceCategory: booking.serviceCategory || "general",
          isACJob: acBooking,
          customerName: user?.name || "Customer",
          customerPhone: user?.phone || "",
          address: booking.address?.trim() || "",
          pincode: booking.pincode || "",
          customerLatitude,
          customerLongitude,
          location: booking.location || null,
          amount: Number(booking.totalAmount || 0),
          price: Number(booking.totalAmount || 0),
          scheduledDate: booking.scheduledDate,
          scheduledTime: booking.scheduledTime,
          status: finalStatus,
          autoAccepted,
          // AC-specific fields for partner app
          unitCount: booking.unitCount || null,
          acTonnage: booking.acTonnage || null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        for (const teamPartner of selectedPartners) {
          const allocation = teamAllocations.find(
            (a) => a.partnerId?.toString() === teamPartner._id.toString()
          );
          const payoutRatio = allocation ? allocation.payoutRatio : 1;
          const partnerAutoAccept = Boolean(teamPartner.autoAccept);

          const partnerSpecificPayload = {
            ...assignmentPayload,
            amount: Number(
              (booking.totalAmount * payoutRatio).toFixed(2)
            ),
            price: Number(
              (booking.totalAmount * payoutRatio).toFixed(2)
            ),
            isTeamJob: teamAllocations.length > 1,
            isPrimary: allocation ? Boolean(allocation.isPrimary) : true,
            status: partnerAutoAccept ? "CONFIRMED" : "ASSIGNED",
            autoAccepted: partnerAutoAccept,
          };

          global.io
            .to(`partner_${teamPartner._id}`)
            .emit("jobAssigned", partnerSpecificPayload);
          global.io
            .to(`partner_${teamPartner._id}`)
            .emit("job_assigned", partnerSpecificPayload);
        }
      }

      console.log(
        `[${acBooking ? "AC" : "BEAUTY"}] Booking ${
          autoAccepted ? "auto-accepted" : "assigned"
        }:`,
        selectedPartners.map((p) => p._id.toString()).join(" & ")
      );
      return primaryPartner;
    }

    // All 3 stages exhausted — escalate
    booking.status = "NO_PARTNER_AVAILABLE";
    booking.assignmentAudit.push({
      stage: booking.assignmentStage || 3,
      event: "NO_PARTNER_AVAILABLE",
      searchedPincodes: [],
      notes: "Exhausted all assignment stages without a valid partner",
      candidates: [],
    });
    await booking.save();

    // Bust slot cache: NO_PARTNER_AVAILABLE no longer holds slot capacity, so
    // the slot may be available to a different (better-matched) customer now.
    try {
      const { clearSlotCache } = require("./scheduling_service");
      clearSlotCache(booking.pincode, booking.scheduledDate);
    } catch (_) { /* non-fatal */ }

    // Tell the customer immediately so the BookingStatusScreen surfaces the
    // "No partner available" banner instead of spinning on SEARCHING.
    if (global.io) {
      global.io.to(`user_${booking.user}`).emit("booking_update", {
        bookingId: booking._id.toString(),
        status: "NO_PARTNER_AVAILABLE",
      });
    }

    // Escalation: notify ops dashboard + customer
    // The escalation service handles:
    //   1. Admin dashboard flag
    //   2. Customer WhatsApp/SMS "finding your partner" message
    //   3. Auto free-rescheduling offer 30 min before scheduled time
    await escalateUnassignedBooking(booking._id);

    return null;
  } catch (error) {
    console.error("Assignment error:", error);
    // Release the lock if the assignment process crashed
    try {
      await Booking.updateOne({ _id: bookingId, status: "ASSIGNING_LOCK" }, { status: "PENDING_ASSIGNMENT" });
    } catch (e) {}
    return null;
  }
}

/*
=====================================================
REASSIGN AFTER CANCEL / REJECT
Handles: partner reject, ACK timeout, admin force,
and customer cancel (partnerId = null).
=====================================================
*/
// Hard cap on reassignment loops. Without this, a booking that no partner accepts
// can recurse forever (reject → reassign → reject → reassign...). At this cap we
// escalate to ops instead — the customer is better served by a human dispatcher
// than by an infinite background spin.
const MAX_REASSIGN_ATTEMPTS = 5;

async function reassignBooking(bookingId, partnerId, options = {}) {
  // `options.skipPartnerPenalty` lets a caller (e.g. cancelBooking HTTP) tell us
  // they've already incremented weeklyCancelCount themselves so we don't double-count.
  // Legacy callers passing a string (e.g. "TIMEOUT") still work — only an object
  // with the flag set true is honoured.
  const skipPartnerPenalty =
    options && typeof options === "object" && options.skipPartnerPenalty === true;

  try {
    const booking = await Booking.findById(bookingId);
    if (!booking) return;

    // Gate: don't reassign already-completed or cancelled bookings
    if (["COMPLETED", "CANCELLED"].includes(booking.status)) return;

    // Hard cap on reassignment attempts — count REASSIGN_REQUESTED audit entries.
    const reassignCount = (booking.assignmentAudit || []).filter(
      (entry) => entry.event === "REASSIGN_REQUESTED"
    ).length;

    if (reassignCount >= MAX_REASSIGN_ATTEMPTS) {
      booking.status = "NO_PARTNER_AVAILABLE";
      booking.assignmentAudit.push({
        stage: booking.assignmentStage || 3,
        event: "REASSIGN_LIMIT_REACHED",
        searchedPincodes: [],
        notes: `Max reassignment attempts (${MAX_REASSIGN_ATTEMPTS}) reached — escalating to ops`,
        candidates: [],
      });
      await booking.save();

      await escalateUnassignedBooking(booking._id);

      if (global.io) {
        global.io.to(`user_${booking.user}`).emit("booking_update", {
          bookingId: booking._id.toString(),
          status: "NO_PARTNER_AVAILABLE",
        });
      }

      console.warn(
        `[reassign] Booking ${bookingId} hit reassignment cap (${reassignCount}). Escalated.`
      );
      return;
    }

    if (partnerId) {
      booking.rejectedPartners.push(partnerId);

      // Apply reliability penalty — unless the caller (HTTP cancelBooking) has
      // already counted this strike themselves. Without the skip flag, an HTTP
      // partner-cancel would increment weeklyCancelCount twice (once in the
      // controller, once here) and auto-suspend after 3 real strikes.
      if (!skipPartnerPenalty) {
        const Partner = require("../models/Partner");
        const rejectingPartner = await Partner.findById(partnerId);
        if (rejectingPartner) {
          // Post-CONFIRMED cancel is penalised double — customer trust impact is higher
          const penalty = booking.status === "CONFIRMED" ? 2 : 1;
          rejectingPartner.weeklyCancelCount =
            (rejectingPartner.weeklyCancelCount || 0) + penalty;

          // Hard suspension: ≥ 5 cancellations in the rolling week
          if (rejectingPartner.weeklyCancelCount >= 5) {
            rejectingPartner.isAvailable = false;
            rejectingPartner.isBlocked = true;
            rejectingPartner.suspendedUntil = new Date(
              Date.now() + 7 * 24 * 60 * 60 * 1000
            );
            console.warn(
              `Partner ${partnerId} auto-suspended for 7 days (weeklyCancelCount = ${rejectingPartner.weeklyCancelCount})`
            );
          }
          await rejectingPartner.save();
        }
      }
    }

    const prevPartner = booking.partner;
    const prevAdditional = booking.additionalPartners || [];

    booking.partner = null;
    booking.additionalPartners = [];
    booking.status = "SEARCHING";
    booking.assignmentAudit.push({
      stage: booking.assignmentStage || 1,
      event: "REASSIGN_REQUESTED",
      searchedPincodes: [],
      selectedPartnerId: partnerId || null,
      notes: partnerId
        ? "Reassignment triggered after partner reject/cancel"
        : "Reassignment triggered (no partner penalised)",
      candidates: [],
    });
    await booking.save();

    // Bust slot cache: the rejecting partner is no longer holding this window,
    // so the slot may now be available to a different customer. Without this,
    // the cache shows the slot as full for up to 30s after reassignment frees it.
    try {
      const { clearSlotCache } = require("./scheduling_service");
      clearSlotCache(booking.pincode, booking.scheduledDate);
    } catch (_) { /* non-fatal */ }

    // Tell the customer we're re-searching so the BookingStatusScreen flips back
    // to "Searching for Partner" instead of staying on a stale ASSIGNED/CONFIRMED.
    if (global.io) {
      global.io.to(`user_${booking.user}`).emit("booking_update", {
        bookingId: booking._id.toString(),
        status: "SEARCHING",
      });
    }

    // Sync operational state for all previously assigned partners
    if (prevPartner) await syncPartnerOperationalState(prevPartner);
    for (const pId of prevAdditional) {
      await syncPartnerOperationalState(pId);
    }
    const prevIds = [
      prevPartner?.toString(),
      ...prevAdditional.map((id) => id.toString()),
    ];
    if (partnerId && !prevIds.includes(partnerId.toString())) {
      await syncPartnerOperationalState(partnerId);
    }

    await assignBooking(bookingId);
  } catch (error) {
    console.error("Reassign error:", error);
  }
}

module.exports = {
  assignBooking,
  reassignBooking,
  isACBooking,
  computeRequiredPartners,
};
