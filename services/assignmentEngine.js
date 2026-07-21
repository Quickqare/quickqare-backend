const Booking = require("../models/Booking");
const User = require("../models/User");
const Partner = require("../models/Partner");
const {
  findEligiblePartnersForBooking,
  syncPartnerOperationalState,
  buildDateTime,
  verifyCakeCapAfterClaim,
  isACCategory,
  computeTeamPackForBooking,
  planTeamAssignment,
  partnerFitsBin,
} = require("./scheduling_service");
const {
  resolveZoneForPincode,
  getZoneCoveragePincodes,
  resolveHubsForCells,
  resolveHubForH3Cell,
  resolveBookingCategories,
} = require("./zone.service");
const { escalateUnassignedBooking } = require("./escalation.service");
const { sendJobAssignedPush } = require("./pushNotification.service");
const { getH3CellsForStage } = require("../utils/h3");
// Shared cached AdminSetting.useH3Zones flag. Re-exported below because
// several modules (booking/partner controllers, zone routes, slotCapacity)
// historically import it from this engine.
const { getUseH3Flag } = require("./useH3Flag.service");

/*
=====================================================
HUB SHADOW LOOKUP
Runs silently alongside pincode assignment (Stage 3).
Logs whether the Hub (H3) path would have found the
same partners. Never throws — fire-and-forget.
=====================================================
*/
async function runH3ShadowLookup(booking, stage, pincodePartnerIds) {
  try {
    if (!booking.h3Cell) return;
    const h3Cells = getH3CellsForStage(booking.h3Cell, stage);
    if (!h3Cells.length) return;

    // Mirror the live hub path exactly (category-scoped, partner-enabled) so
    // the shadow numbers predict what hub mode would really do.
    const categoryIds = (await resolveBookingCategories(booking)).map((c) => c.id);
    const hubIds = await resolveHubsForCells(h3Cells, {
      categoryIds: categoryIds.length ? categoryIds : null,
      requirePartnerApp: true,
    });
    if (!hubIds.length) {
      console.log(
        `[Hub Shadow] booking=${booking._id} stage=${stage} ` +
        `pincode=${pincodePartnerIds.length} hubs=0 (no hub covers this cell)`
      );
      return;
    }

    const hubPartners = await Partner.find({
      isBlocked: false,
      // Enum value is uppercase — the old lowercase "approved" matched zero
      // partners, so every shadow log falsely reported hub=0.
      approvalStatus: "APPROVED",
      assignedHubId: { $in: hubIds },
    }).select("_id").lean();

    const hubPartnerIds = new Set(hubPartners.map((p) => String(p._id)));
    const pinIds = new Set(pincodePartnerIds.map(String));

    const onlyInPincode = [...pinIds].filter((id) => !hubPartnerIds.has(id));
    const onlyInHub     = [...hubPartnerIds].filter((id) => !pinIds.has(id));
    const matched       = [...pinIds].filter((id) => hubPartnerIds.has(id));

    console.log(
      `[Hub Shadow] booking=${booking._id} stage=${stage} ` +
      `pincode=${pinIds.size} hub=${hubPartnerIds.size} ` +
      `matched=${matched.length} onlyPincode=${onlyInPincode.length} onlyHub=${onlyInHub.length}`
    );
  } catch (err) {
    console.error("[Hub Shadow] error:", err.message);
  }
}

/*
=====================================================
GET PINCODES BY ASSIGNMENT STAGE
Stages are CUMULATIVE — each wider stage still includes every narrower one,
mirroring the H3 path (gridDisk is inclusive). Stage 2 previously searched
ONLY nearbyPincodes and stage 3 ONLY extendedPincodes, silently dropping
home-pincode partners: a 3-partner job with 2 candidates at home and 2 nearby
failed every stage (2<3, then a different 2<3) even though 4 eligible
partners existed across the zone.
=====================================================
*/
function dedupePincodes(list) {
  return [
    ...new Set(list.map((p) => String(p || "").trim()).filter(Boolean)),
  ];
}

async function getPincodesForStage(booking) {
  if (booking.assignmentStage === 1) {
    return [booking.pincode];
  }

  const zone = await resolveZoneForPincode(booking.pincode);
  if (!zone || zone.isActive === false) return [booking.pincode];
  if (zone.partnerAppEnabled === false) return [];

  if (booking.assignmentStage === 2) {
    return dedupePincodes([
      booking.pincode,
      ...(Array.isArray(zone.nearbyPincodes) ? zone.nearbyPincodes : []),
    ]);
  }

  // Stage 3: full zone coverage (home + nearby + extended).
  return dedupePincodes([booking.pincode, ...getZoneCoveragePincodes(zone)]);
}

/*
=====================================================
DETECT AC BOOKING
AC bookings use different bin capacity and skill
weighting than general / mehendi bookings.

Scans the top-level serviceCategory AND every cart line's category/name —
matching createBooking and buildRequestContext. Previously only
serviceCategory was checked, so a cart whose top-level category wasn't "ac"
but contained AC services got mehendi bin-packing (420-min bins, wrong
buffer) in computeRequiredPartners.
=====================================================
*/
function isACBooking(booking) {
  if (isACCategory(booking?.serviceCategory || "")) return true;
  return (Array.isArray(booking?.services) ? booking.services : []).some(
    (s) => isACCategory(s?.category || "") || isACCategory(s?.name || "")
  );
}

/*
=====================================================
COMPUTE REQUIRED PARTNERS (TEAM PACK)
Delegates to the shared packer in scheduling_service —
one packing model drives team sizing, payout split,
slot feasibility and the booking's elapsed duration.
The pack caps each partner's share at the visit
window (240 min), splits bridal work across the two
parallel artists, discounts 2nd+ AC units of the same
line, and tags each bin with its skill requirements
(technician tier / bridal capability).
Returns { requiredCount, bins, dedicatedMinutes,
taskBins, makespanMinutes }.
=====================================================
*/
async function computeRequiredPartners(booking) {
  return computeTeamPackForBooking(booking);
}

// Human-readable bin summary for assignment audit notes.
function describeTeamPack(teamPack) {
  const bins = Array.isArray(teamPack?.bins) ? teamPack.bins : [];
  if (!bins.length) return "1 partner, whole job";
  const bridal = bins.filter((b) => b.kind === "BRIDAL").length;
  const tier2 = bins.filter((b) => (b.tier || 1) >= 2).length;
  const rest = bins.length - bridal - tier2;
  const parts = [];
  if (bridal) parts.push(`${bridal} bridal`);
  if (tier2) parts.push(`${tier2} technician-tier`);
  if (rest > 0) parts.push(`${rest} general`);
  return parts.join(", ");
}

/*
=====================================================
RELEASE CAPACITY FOR AN UNASSIGNABLE BOOKING
A booking that lands in NO_PARTNER_AVAILABLE (stage exhaustion, reassign cap,
or a window already in the past) is not going to be staffed — its reserved
SlotCapacity units must go back to the pool so other customers can book the
window. Release is idempotent (the lock flips to RELEASED once), so a later
escalation auto-cancel calling release again is a safe no-op. Lazy require +
never-throws: capacity bookkeeping must not break the assignment flow.
=====================================================
*/
async function releaseSlotCapacityForUnassignable(bookingId, reason) {
  try {
    const { releaseSlotCapacityByBookingId } = require("./slotCapacity.service");
    await releaseSlotCapacityByBookingId(bookingId, { releaseReason: reason });
  } catch (err) {
    console.error(
      `[assignment] Slot capacity release failed for booking ${bookingId} (${reason}): ${err.message}`
    );
  }
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
    // GUARDED on ASSIGNING_LOCK: a full-doc save here could overwrite a
    // concurrent user/admin cancel (refund issued, then status flipped back).
    if (minutesToService < -60) {
      const expired = await Booking.findOneAndUpdate(
        { _id: booking._id, status: "ASSIGNING_LOCK" },
        {
          $set: { status: "NO_PARTNER_AVAILABLE" },
          $push: {
            assignmentAudit: {
              stage: booking.assignmentStage || 1,
              event: "NO_PARTNER_AVAILABLE",
              searchedPincodes: [],
              notes: `Service window already passed (${Math.round(-minutesToService)} min ago) — cannot assign`,
              candidates: [],
            },
          },
        },
        { new: true }
      );
      if (expired) {
        await releaseSlotCapacityForUnassignable(booking._id, "no_partner_window_passed");
        await escalateUnassignedBooking(booking._id);
      }
      return null;
    }

    const requireOnline = opts.requireOnline !== undefined
      ? opts.requireOnline
      : minutesToService <= 30; // only require online for imminent bookings

    // Hub (H3) path is active only when the flag is on AND this booking has a
    // derived h3Cell. A booking without an h3Cell (e.g. created before H3
    // rollout, or with no coordinates) safely falls back to the pincode path.
    // Resolved once so every stage of this attempt runs in the same mode.
    const hubMode = (await getUseH3Flag()) && Boolean(booking.h3Cell);

    // Hub mode: resolve the booking's categories once (hubs are per-category
    // and may overlap the same cells), and enforce the home-hub pause gate up
    // front — a booking whose own hub is switched off for partner jobs must
    // not be staffed from neighbouring hubs via ring expansion.
    let hubCategoryIds = null;
    let pausedHomeHubName = null;
    if (hubMode) {
      hubCategoryIds = (await resolveBookingCategories(booking)).map((c) => c.id);
      for (const catId of hubCategoryIds.length ? hubCategoryIds : [null]) {
        const homeHub = await resolveHubForH3Cell(booking.h3Cell, { categoryId: catId });
        if (homeHub && homeHub.partnerAppEnabled === false) {
          pausedHomeHubName = homeHub.name;
          break;
        }
      }
    }

    // Hub mode stage-skip bookkeeping: partners match by hub membership, so a
    // wider ring that reaches no NEW hubs re-runs an identical search.
    let prevStageHubKey = null;
    let prevStageFailedDeterministically = false;

    for (let stage = booking.assignmentStage || 1; stage <= 3; stage += 1) {
      booking.assignmentStage = stage;
      await booking.save();

      // ── Stage cell/pincode expansion ──────────────────────────────────────
      let pincodesToSearch;
      let stageHubIds = null; // hub mode: precomputed pool for this stage
      if (hubMode) {
        pincodesToSearch = getH3CellsForStage(booking.h3Cell, stage);

        if (pausedHomeHubName) {
          booking.assignmentAudit.push({
            stage,
            event: "NO_ELIGIBLE_PARTNERS",
            searchedPincodes: pincodesToSearch,
            notes: `Hub "${pausedHomeHubName}" is paused for partner jobs (partnerAppEnabled=false)`,
            candidates: [],
          });
          await booking.save();
          continue;
        }

        stageHubIds = await resolveHubsForCells(pincodesToSearch, {
          categoryIds: hubCategoryIds && hubCategoryIds.length ? hubCategoryIds : null,
          requirePartnerApp: true,
        });
        const stageHubKey = stageHubIds.map(String).sort().join("|");

        // Skip a stage whose hub set is identical to the previous one — the
        // candidate pool cannot have changed. Claim-contention failures are
        // the exception: those lose a race, not the pool, so retry them.
        if (
          prevStageHubKey !== null &&
          stageHubKey === prevStageHubKey &&
          prevStageFailedDeterministically
        ) {
          booking.assignmentAudit.push({
            stage,
            event: "STAGE_SKIPPED_NO_NEW_HUBS",
            searchedPincodes: pincodesToSearch,
            notes: "Ring expansion reached no additional hubs — candidate pool unchanged from previous stage",
            candidates: [],
          });
          await booking.save();
          continue;
        }
        prevStageHubKey = stageHubKey;

        if (!stageHubIds.length) {
          booking.assignmentAudit.push({
            stage,
            event: "NO_ELIGIBLE_PARTNERS",
            searchedPincodes: pincodesToSearch,
            notes: "No partner-enabled hub of this booking's category covers this stage's cells",
            candidates: [],
          });
          await booking.save();
          prevStageFailedDeterministically = true;
          continue;
        }
      } else {
        pincodesToSearch = await getPincodesForStage(booking);
      }

      if (!pincodesToSearch.length) {
        booking.assignmentAudit.push({
          stage,
          event: "NO_PINCODES_TO_SEARCH",
          searchedPincodes: [],
          notes: hubMode
            ? "H3 ring expansion returned no cells"
            : "Zone expansion returned no searchable pincodes",
        });
        await booking.save();
        prevStageFailedDeterministically = true;
        continue;
      }

      const rankedPartners = await findEligiblePartnersForBooking(
        booking,
        pincodesToSearch,
        { requireOnline, useH3: hubMode, precomputedHubIds: stageHubIds }
      );

      // ── Shadow log (Stage 3 — only when running on pincode path) ─────────
      if (!hubMode) {
        const pincodePartnerIds = rankedPartners.map((e) => e.partner._id);
        runH3ShadowLookup(booking, stage, pincodePartnerIds).catch(() => {});
      }

      if (!rankedPartners.length) {
        booking.assignmentAudit.push({
          stage,
          event: "NO_ELIGIBLE_PARTNERS",
          searchedPincodes: pincodesToSearch,
          notes: "No partner passed production eligibility and scoring filters",
          candidates: [],
        });
        await booking.save();
        prevStageFailedDeterministically = true;
        continue;
      }

      // Compute the team pack: how many partners, each partner's share (bin)
      // and its skill requirements (technician tier / bridal capability).
      const teamPack = await computeRequiredPartners(booking);
      const { requiredCount } = teamPack;

      // Match ranked partners to bins. Null = the pool can't fill every ROLE
      // (not just the headcount) — e.g. three guest artists but no
      // bridal-capable one, or cleanings covered but no technician for the
      // gas-refill bin. Try the next wider zone.
      const stagePlan = planTeamAssignment(rankedPartners, teamPack);
      if (!stagePlan) {
        booking.assignmentAudit.push({
          stage,
          event: "INSUFFICIENT_PARTNERS",
          searchedPincodes: pincodesToSearch,
          notes: `Need ${requiredCount} partner(s) [${describeTeamPack(teamPack)}], pool of ${rankedPartners.length} cannot fill every role in stage ${stage}`,
          candidates: rankedPartners.slice(0, 5).map((e) => ({ partnerId: e.partner._id, score: e.score })),
        });
        await booking.save();
        prevStageFailedDeterministically = true;
        continue;
      }

      // ── ATOMIC PARTNER CLAIM ──────────────────────────────────────────
      // Fill the plan slot by slot (most restrictive bins first), atomically
      // claiming each partner for this exact slot via a guarded $push.
      // MongoDB serialises writes to a single document, so when two bookings
      // race for the same partner (e.g. a "tatkal" rush on one slot) only the
      // first claim's guard passes — the second sees the slot already present,
      // returns null, and that bin falls through to the next CAPABLE candidate.
      // This is what prevents one partner being handed two overlapping jobs;
      // the per-booking ASSIGNING_LOCK cannot, because it locks the booking,
      // not the partner.
      const claimDate = booking.scheduledDate;
      const claimTime = booking.scheduledTime;
      const selectedTeam = []; // { partner, bin } in slot order (lead first)
      const claimedIds = new Set();
      const failedClaimIds = new Set();

      for (const { bin } of stagePlan) {
        let claimedForBin = null;
        for (const entry of rankedPartners) {
          const candidateId = String(entry.partner._id);
          if (claimedIds.has(candidateId) || failedClaimIds.has(candidateId)) continue;
          if (!partnerFitsBin(entry, bin)) continue;

          const claimed = await Partner.findOneAndUpdate(
            {
              _id: entry.partner._id,
              busySlots: {
                $not: { $elemMatch: { date: claimDate, time: claimTime } },
              },
            },
            { $push: { busySlots: { date: claimDate, time: claimTime } } },
            { new: true }
          );

          if (claimed) {
            claimedForBin = claimed;
            claimedIds.add(candidateId);
            break;
          }
          failedClaimIds.add(candidateId);
        }
        if (!claimedForBin) break;
        selectedTeam.push({ partner: claimedForBin, bin });
      }

      const selectedPartners = selectedTeam.map((t) => t.partner);

      // Couldn't lock a capable partner for every bin — parallel assignments
      // won the race for the rest. Release whatever we did grab (sync rebuilds
      // busySlots from committed bookings, dropping our uncommitted claim) and
      // widen to the next stage. A half-staffed team is worse than retrying.
      if (selectedTeam.length < stagePlan.length) {
        for (const claimedPartner of selectedPartners) {
          await syncPartnerOperationalState(claimedPartner._id);
        }
        booking.assignmentAudit.push({
          stage,
          event: "CLAIM_CONTENTION",
          searchedPincodes: pincodesToSearch,
          notes: `Claimed ${selectedTeam.length}/${stagePlan.length} role slot(s) before parallel assignments took the rest — retrying wider`,
          candidates: rankedPartners
            .slice(0, 5)
            .map((e) => ({ partnerId: e.partner._id, score: e.score })),
        });
        await booking.save();
        // A lost claim race is not deterministic — the same pool is worth
        // retrying at the next stage even if it reaches no new hubs.
        prevStageFailedDeterministically = false;
        continue;
      }

      // ── Cake daily-cap re-verification ─────────────────────────────────
      // The cap filter inside findEligiblePartnersForBooking ran BEFORE
      // scoring/team sizing, so two concurrent cake bookings for the same
      // baker on the same day (different time slots — which the busySlots
      // claim guard does not serialize) can both have passed it. Now that our
      // claim is placed, recount: any claimed baker who is meanwhile at the
      // cap gets released, and we retry as claim contention.
      const overCapPartnerIds = await verifyCakeCapAfterClaim(
        booking,
        selectedPartners.map((p) => p._id)
      );
      if (overCapPartnerIds.length) {
        for (const claimedPartner of selectedPartners) {
          await syncPartnerOperationalState(claimedPartner._id);
        }
        booking.assignmentAudit.push({
          stage,
          event: "CLAIM_CONTENTION",
          searchedPincodes: pincodesToSearch,
          notes: `Cake daily cap reached for partner(s) ${overCapPartnerIds.join(", ")} between eligibility check and claim — released claims, retrying`,
          candidates: rankedPartners
            .slice(0, 5)
            .map((e) => ({ partnerId: e.partner._id, score: e.score })),
        });
        await booking.save();
        // Same-pool retry is worth it: the next attempt re-runs eligibility,
        // which now sees the winner's booking and drops the full baker.
        prevStageFailedDeterministically = false;
        continue;
      }

      const primaryPartner = selectedPartners[0];
      const additionalPartners = selectedPartners.slice(1);

      // Identify standby partners (up to 3 next best candidates we didn't claim)
      const standbyCandidates = rankedPartners
        .filter((e) => !claimedIds.has(String(e.partner._id)))
        .slice(0, 3)
        .map((e) => e.partner._id);

      // Build proportional workload + payout mapping from each partner's OWN
      // bin (not an index-matched sorted list — the plan already pairs every
      // partner with the exact share they'll work).
      // The last partner absorbs the rounding remainder so the ratios sum to
      // exactly 1.0 — otherwise toFixed(4) leaves a few paise unallocated and
      // the customer's totalAmount never fully matches sum(partner earnings).
      const totalWorkloadMinutes =
        selectedTeam.reduce((sum, t) => sum + (t.bin.minutes || 0), 0) || 1;

      let assignedRatioSum = 0;
      const teamAllocations = selectedTeam.map((t, index) => {
        const isLast = index === selectedTeam.length - 1;
        let payoutRatio;
        if (isLast) {
          payoutRatio = Number(Math.max(1 - assignedRatioSum, 0).toFixed(4));
        } else {
          payoutRatio = Number(
            ((t.bin.minutes || 0) / totalWorkloadMinutes).toFixed(4)
          );
          assignedRatioSum = Number((assignedRatioSum + payoutRatio).toFixed(4));
        }
        return {
          partnerId: t.partner._id,
          assignedMinutes: t.bin.minutes || 0,
          payoutRatio,
          isPrimary: index === 0,
        };
      });

      const autoAccepted = Boolean(primaryPartner.autoAccept);
      const finalStatus = autoAccepted ? "CONFIRMED" : "ASSIGNED";

      // GUARDED ATOMIC ASSIGNMENT: only commit the partner + status while the
      // booking is still ASSIGNING_LOCK. The previous full-document save could
      // overwrite a concurrent cancel (user cancel / admin force-cancel) that
      // landed during the search — the customer got a refund AND a partner was
      // dispatched. If the guard fails, release the claimed partners and stop.
      //
      // assignedAt anchors the advance-ACK deadline (see ackTimeout.service) —
      // set on every (re)assignment so each newly attached partner gets a fresh
      // window. ackReceivedAt is stamped for auto-accepted bookings (no manual
      // ACK needed) and explicitly RESET for manual-accept ones so a previous
      // partner's acknowledgement can never satisfy the new partner's ACK gate.
      //
      // autoRefundIfUnassigned: a partner is now attached, so the partner-cancel
      // auto-refund window is closed. Clear the flag (set by cancelBooking on a
      // partner cancel) — otherwise it stays sticky across this partner's
      // tenure, and a much-later re-search exhaustion would wrongly auto-cancel
      // + refund a booking we did manage to staff. If THIS partner later
      // cancels, cancelBooking re-arms it.
      const assignedBooking = await Booking.findOneAndUpdate(
        { _id: booking._id, status: "ASSIGNING_LOCK" },
        {
          $set: {
            partner: primaryPartner._id,
            teamAllocations,
            additionalPartners: additionalPartners.map((p) => p._id),
            standbyPartners: standbyCandidates,
            status: finalStatus,
            assignedAt: new Date(),
            autoRefundIfUnassigned: false,
            ackReceivedAt: autoAccepted ? new Date() : null,
          },
          $push: {
            assignmentAudit: {
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
                rating: Number(entry.partner?.rating ?? 0),
                // Full per-component breakdown so the weight-shadow report can
                // recompute rankings under any weighting without re-querying.
                fairnessScore: Number(entry.fairnessScore || 0),
                earningsScore: Number(entry.earningsScore || 0),
                distanceScore: Number(entry.distanceScore || 0),
                skillScore: Number(entry.skillScore || 0),
                reliabilityScore: Number(entry.reliabilityScore || 0),
                autoAccept: Boolean(entry.partner?.autoAccept),
              })),
            },
          },
        },
        { new: true }
      );

      if (!assignedBooking) {
        // Booking moved on (cancelled/rescheduled) while we were claiming
        // partners — release the claims and do NOT hand out the job. Sync
        // rebuilds busySlots from committed bookings, dropping our claim.
        for (const claimedPartner of selectedPartners) {
          await syncPartnerOperationalState(claimedPartner._id);
        }
        console.warn(
          `[assignment] Booking ${booking._id} changed state during assignment — claims released, no partner dispatched`
        );
        return null;
      }

      // Schedule ACK timeout only for manual-accept bookings (ASSIGNED).
      // Auto-accepted bookings (CONFIRMED) already have ackReceivedAt set above —
      // no partner action required, so no timeout needed.
      //
      // The 2-minute timer is for IMMINENT jobs only. Advance assignments
      // (start >3h away — e.g. cake orders assigned at payment time, or any
      // evening payment for a next-morning slot) may land while the partner is
      // legitimately offline/asleep; a 2-minute window would churn through
      // every candidate in the zone within minutes. Those get the wider
      // deadline (12h from assignment, capped at T-3h) enforced by the
      // enforceAdvanceAckDeadlines cron instead. handleAckTimeout carries the
      // same guard, so a stray timer fire on an advance booking is a no-op.
      if (!autoAccepted) {
        try {
          const {
            scheduleAckTimeout,
            ADVANCE_IMMINENT_MS,
          } = require("./ackTimeout.service");
          if (minutesToService * 60 * 1000 <= ADVANCE_IMMINENT_MS) {
            await scheduleAckTimeout(booking._id, primaryPartner._id);
          }
        } catch (timeoutErr) {
          console.error("ACK timeout schedule error:", timeoutErr.message);
        }
      }

      // Reconcile each claimed partner's operational state now that the booking
      // is persisted with them attached. The slot was already locked by the
      // atomic claim above; here we stamp the fairness timestamp and let
      // syncPartnerOperationalState recompute activeJobs/busySlots from committed
      // bookings so the live counts are exact. A targeted $set (not a full-doc
      // save) avoids clobbering any concurrent update to the partner.
      for (const teamPartner of selectedPartners) {
        const update = { $set: { lastAssignedAt: new Date() } };
        // Reliability acceptance tracking (primary partner only — the one gated
        // on ACK and the one reassignment revolves around). Every soft-assign
        // is an offer (assignedCount); an auto-accept partner accepts it here
        // and now, so bump acceptedCount too. Manual-accept partners get their
        // acceptedCount in acceptJobCore instead — guarded there against
        // double-counting, so the two paths never both fire for one offer.
        if (teamPartner._id.toString() === primaryPartner._id.toString()) {
          update.$inc = autoAccepted
            ? { assignedCount: 1, acceptedCount: 1 }
            : { assignedCount: 1 };
        }
        await Partner.updateOne({ _id: teamPartner._id }, update);
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
          houseDetails: booking.houseDetails?.trim() || null,
          landmark: booking.landmark?.trim() || null,
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

      // Push notification to each assigned partner — reaches them even with the
      // app closed/backgrounded, where the socket emit above cannot. Fire and
      // forget: sendJobAssignedPush swallows its own errors and never rejects.
      for (const teamPartner of selectedPartners) {
        if (teamPartner.fcmToken) {
          sendJobAssignedPush(teamPartner.fcmToken, String(booking._id));
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

    // All 3 stages exhausted — queue for retry if caller requested, else escalate.
    // Both writes are GUARDED on ASSIGNING_LOCK so a concurrent cancel can't be
    // overwritten by a stale full-document save (same race as the assign write).
    if (opts.queueOnFailure) {
      const queued = await Booking.findOneAndUpdate(
        { _id: booking._id, status: "ASSIGNING_LOCK" },
        {
          $set: { status: "QUEUED" },
          $push: {
            assignmentAudit: {
              stage: booking.assignmentStage || 3,
              event: "QUEUED",
              searchedPincodes: [],
              notes: "No partner available at booking time — queued for cron retry",
              candidates: [],
            },
          },
        },
        { new: true }
      );
      if (!queued) return null; // booking moved on concurrently — leave it alone

      if (global.io) {
        global.io.to(`user_${booking.user}`).emit("booking_update", {
          bookingId: booking._id.toString(),
          status: "QUEUED",
        });
      }

      return null;
    }

    const unassignable = await Booking.findOneAndUpdate(
      { _id: booking._id, status: "ASSIGNING_LOCK" },
      {
        $set: { status: "NO_PARTNER_AVAILABLE" },
        $push: {
          assignmentAudit: {
            stage: booking.assignmentStage || 3,
            event: "NO_PARTNER_AVAILABLE",
            searchedPincodes: [],
            notes: "Exhausted all assignment stages without a valid partner",
            candidates: [],
          },
        },
      },
      { new: true }
    );
    if (!unassignable) return null; // booking moved on concurrently — leave it alone

    // Release the reserved SlotCapacity units AND bust the slot cache — a
    // booking we can't staff must not keep blocking the window for other
    // customers. (Previously only the cache was busted; the reservedUnits
    // stayed incremented and the slot showed full for the rest of the day.)
    await releaseSlotCapacityForUnassignable(booking._id, "no_partner_available");
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

    await escalateUnassignedBooking(booking._id);

    return null;
  } catch (error) {
    console.error("Assignment error:", error);
    // Record the crash on the booking so it's visible in the admin panel /
    // diagnostics instead of vanishing (a swallowed error here previously left
    // bookings stuck with no audit trail — see the h3-js outage). Use $push so
    // it works even if `booking` was never loaded before the throw.
    try {
      await Booking.updateOne(
        { _id: bookingId },
        {
          $push: {
            assignmentAudit: {
              stage: 0,
              event: "ASSIGNMENT_ERROR",
              searchedPincodes: [],
              notes: `Assignment crashed: ${String(error?.message || error).slice(0, 300)}`,
              candidates: [],
            },
          },
        }
      );
    } catch (e) {
      console.error("Assignment error: failed to record audit entry:", e.message);
    }
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

    // Gate: don't reassign already-completed/cancelled bookings, nor one the customer
    // is actively rescheduling (NEEDS_RESCHEDULING) — that flow owns the slot.
    if (["COMPLETED", "CANCELLED", "NEEDS_RESCHEDULING"].includes(booking.status)) return;

    // Hard cap on reassignment attempts — count REASSIGN_REQUESTED audit entries.
    const reassignCount = (booking.assignmentAudit || []).filter(
      (entry) => entry.event === "REASSIGN_REQUESTED"
    ).length;

    if (reassignCount >= MAX_REASSIGN_ATTEMPTS) {
      // Guarded atomic update so a concurrent reschedule/cancel/complete isn't clobbered
      // by a stale full-document save.
      const capped = await Booking.findOneAndUpdate(
        { _id: bookingId, status: { $nin: ["COMPLETED", "CANCELLED", "NEEDS_RESCHEDULING"] } },
        {
          $set: { status: "NO_PARTNER_AVAILABLE" },
          $push: {
            assignmentAudit: {
              stage: booking.assignmentStage || 3,
              event: "REASSIGN_LIMIT_REACHED",
              searchedPincodes: [],
              notes: `Max reassignment attempts (${MAX_REASSIGN_ATTEMPTS}) reached — escalating to ops`,
              candidates: [],
            },
          },
        },
        { new: true }
      );
      if (!capped) return; // booking moved on concurrently — abort.

      await releaseSlotCapacityForUnassignable(booking._id, "reassign_limit_reached");
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
      // Apply reliability penalty — unless the caller (HTTP cancelBooking) has
      // already counted this strike themselves. Without the skip flag, an HTTP
      // partner-cancel would increment weeklyCancelCount twice (once in the
      // controller, once here) and auto-suspend after 3 real strikes.
      //
      // recordPartnerStrike is the shared atomic implementation (same as the
      // HTTP cancel path): it applies the rolling-7-day weekly reset before
      // adding the strike — the old read-modify-write here never reset, so a
      // stale months-old count plus one ACK timeout could wrongly suspend a
      // partner — and it can't clobber a concurrent strike's counters.
      if (!skipPartnerPenalty) {
        try {
          const { recordPartnerStrike } = require("./partnerLifecycle.service");
          // Post-CONFIRMED cancel is penalised double — customer trust impact is higher
          await recordPartnerStrike(partnerId, {
            strikes: booking.status === "CONFIRMED" ? 2 : 1,
          });
        } catch (strikeErr) {
          console.error(`[reassign] Strike recording failed for partner ${partnerId}: ${strikeErr.message}`);
        }
      }
    }

    const prevPartner = booking.partner;
    const prevAdditional = booking.additionalPartners || [];

    // Guarded atomic release: only $set/$push the reassignment fields, and only if the
    // booking is still reassign-eligible. This avoids a stale full-document save clobbering
    // a concurrent reschedule (which would otherwise revert the slot + re-arm autoRefund).
    const pushOps = {
      assignmentAudit: {
        stage: booking.assignmentStage || 1,
        event: "REASSIGN_REQUESTED",
        searchedPincodes: [],
        selectedPartnerId: partnerId || null,
        notes: partnerId
          ? "Reassignment triggered after partner reject/cancel"
          : "Reassignment triggered (no partner penalised)",
        candidates: [],
      },
    };
    if (partnerId) pushOps.rejectedPartners = partnerId;

    const released = await Booking.findOneAndUpdate(
      { _id: bookingId, status: { $nin: ["COMPLETED", "CANCELLED", "NEEDS_RESCHEDULING"] } },
      {
        $set: { partner: null, additionalPartners: [], status: "SEARCHING" },
        $push: pushOps,
      },
      { new: true }
    );

    if (!released) return; // concurrently rescheduled/cancelled/completed — abort reassignment.

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
  getUseH3Flag,
};
