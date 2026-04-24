const Booking = require("../models/Booking");
const User = require("../models/User");
const Zone = require("../models/zone.model");
const {
  findEligiblePartnersForBooking,
  syncPartnerOperationalState,
} = require("./scheduling.service");

/*
=====================================================
GET PINCODES BY ASSIGNMENT STAGE
=====================================================
*/
async function getPincodesForStage(booking) {
  if (booking.assignmentStage === 1) {
    return [booking.pincode];
  }

  const zone = await Zone.findOne({
    pincode: booking.pincode,
    isActive: true,
  });

  if (!zone) return [booking.pincode];
  if (zone.partnerAppEnabled === false) return [];

  if (booking.assignmentStage === 2 && zone.nearbyPincodes?.length) {
    return zone.nearbyPincodes;
  }

  if (booking.assignmentStage === 3 && zone.extendedPincodes?.length) {
    return zone.extendedPincodes;
  }

  return [booking.pincode];
}

/*
=====================================================
ASSIGN BOOKING
=====================================================
*/
async function assignBooking(bookingId) {
  try {
    const booking = await Booking.findById(bookingId);
    if (!booking || booking.partner) return null;

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
        pincodesToSearch
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

      let bridalPartners = 0;
      const bridalPartnerMinutes = [];
      const handTasks = [];
      const addonFeetTasks = [];
      const independentTasks = [];

      if (Array.isArray(booking.services)) {
        const Service = require("../models/service.model");
        const serviceIds = booking.services.map((s) => s.serviceId).filter(Boolean);
        const servicesData = await Service.find({ _id: { $in: serviceIds } }).lean();
        const serviceMap = new Map(servicesData.map((s) => [String(s._id), s]));

        const ADDON_FEET_NAMES = ["basic feet", "feet", "ankle", "above ankle"];
        const INDEPENDENT_FEET_NAMES = ["mid leg", "below knee", "mehendi for guests"];

        booking.services.forEach((s) => {
          const cat = String(s.category || "").toLowerCase();
          const name = String(s.name || "").toLowerCase();
          const isMehendi = cat.includes("mehendi") || name.includes("mehendi");

          if (isMehendi) {
            const quantity = Math.max(Number(s.quantity || 1), 1);
            const serviceRef = serviceMap.get(String(s.serviceId));
            const duration = serviceRef ? Number(serviceRef.duration || 60) : 60;

            if (name.includes("bridal mehendi")) {
              // Phase 1: Dedicated Bridal Allocation (1 Bride = 2 Partners)
              bridalPartners += quantity * 2;
              // Usually 2 artists work simultaneously, so they each get credited for the full duration
              // or you can allocate proportional duration. Here we assign the task duration to each.
              for (let i = 0; i < quantity * 2; i++) {
                bridalPartnerMinutes.push(duration);
              }
            } else {
              // Sort tasks into independent buckets for blocking
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
          }
        });
      }

      // Phase 2: Task Block Construction
      // Sort descending to pair the largest hands with the largest feet
      handTasks.sort((a, b) => b - a);
      addonFeetTasks.sort((a, b) => b - a);

      const taskBlocks = [];
      for (const feetDuration of addonFeetTasks) {
        // Merge Hand + Add-on Feet into a single unbroken block
        if (handTasks.length > 0) {
          const handDuration = handTasks.shift();
          taskBlocks.push(handDuration + feetDuration);
        } else {
          taskBlocks.push(feetDuration);
        }
      }
      // Push remaining independent and unpaired tasks
      taskBlocks.push(...handTasks);
      taskBlocks.push(...independentTasks);

      // Phase 3 & 4: Largest-Task-First Packing (FFD with Flex Capacity)
      taskBlocks.sort((a, b) => b - a);
      const partnerBins = [];
      const MAX_CAPACITY = 420; // 7 Hours max load per guest partner

      for (const task of taskBlocks) {
        let placed = false;
        // Find the first partner bin that can fit this task block without exceeding MAX_CAPACITY
        for (let i = 0; i < partnerBins.length; i++) {
          if (partnerBins[i] + task <= MAX_CAPACITY) {
            partnerBins[i] += task;
            placed = true;
            break;
          }
        }
        // If no existing partner has space, dispatch a new partner to the team
        if (!placed) {
          partnerBins.push(task);
        }
      }

      // Phase 5: Final Output Calculation
      const guestPartners = partnerBins.length;
      const requiredPartnersCount = Math.max(bridalPartners + guestPartners, 1);

      // Pull up to the required amount of partners from the ranked list
      const selectedPartners = rankedPartners.slice(0, requiredPartnersCount).map(r => r.partner);
      const primaryPartner = selectedPartners[0];
      const additionalPartners = selectedPartners.slice(1);
      
      // Map workloads and calculate proportional payout ratios
      const allPartnerWorkloads = [...bridalPartnerMinutes, ...partnerBins].sort((a, b) => b - a);
      const totalWorkloadMinutes = allPartnerWorkloads.reduce((a, b) => a + b, 0) || 1;

      const teamAllocations = selectedPartners.map((p, index) => {
        const mins = allPartnerWorkloads[index] || 0;
        return {
          partnerId: p._id,
          assignedMinutes: mins,
          payoutRatio: Number((mins / totalWorkloadMinutes).toFixed(4)),
          isPrimary: index === 0
        };
      });

      const autoAccepted = Boolean(primaryPartner.autoAccept);
      
      // Soft assignment confirmation mapping
      const finalStatus = autoAccepted ? "CONFIRMED" : "ASSIGNED";

      booking.partner = primaryPartner._id;
      booking.set("teamAllocations", teamAllocations);
      if (additionalPartners.length > 0) {
        booking.set("additionalPartners", additionalPartners.map(p => p._id), { strict: false });
      }

      booking.status = finalStatus;
      booking.assignmentAudit.push({
        stage,
        event: autoAccepted ? "CONFIRMED_AUTO" : "SOFT_ASSIGNED",
        searchedPincodes: pincodesToSearch,
        selectedPartnerId: primaryPartner._id,
        notes: `Selected top-ranked partner${autoAccepted ? " with auto-accept enabled" : ""}`,
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
          customerName: user?.name || "Customer",
          customerPhone: user?.phone || "",
          address: booking.address || booking.pincode || "Address not available",
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
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        for (const teamPartner of selectedPartners) {
          const allocation = teamAllocations.find(a => a.partnerId?.toString() === teamPartner._id.toString());
          const payoutRatio = allocation ? allocation.payoutRatio : 1;
          const partnerAutoAccept = Boolean(teamPartner.autoAccept);

          const partnerSpecificPayload = {
            ...assignmentPayload,
            amount: Number((booking.totalAmount * payoutRatio).toFixed(2)),
            price: Number((booking.totalAmount * payoutRatio).toFixed(2)),
            isTeamJob: teamAllocations.length > 1,
            isPrimary: allocation ? Boolean(allocation.isPrimary) : true,
            status: partnerAutoAccept ? "CONFIRMED" : "ASSIGNED",
            autoAccepted: partnerAutoAccept,
          };

          global.io.to(`partner_${teamPartner._id}`).emit("jobAssigned", partnerSpecificPayload);
          global.io.to(`partner_${teamPartner._id}`).emit("job_assigned", partnerSpecificPayload);
        }
      }

      console.log(
        `Booking ${autoAccepted ? "auto-accepted" : "assigned"}:`,
        selectedPartners.map(p => p._id.toString()).join(" & ")
      );
      return primaryPartner;
    }

    booking.status = "NO_PARTNER_AVAILABLE";
    booking.assignmentAudit.push({
      stage: booking.assignmentStage || 3,
      event: "NO_PARTNER_AVAILABLE",
      searchedPincodes: [],
      notes: "Exhausted all assignment stages without a valid partner",
      candidates: [],
    });
    await booking.save();
    return null;
  } catch (error) {
    console.error("Assignment error:", error);
    return null;
  }
}

/*
=====================================================
REASSIGN AFTER CANCEL / REJECT
=====================================================
*/
async function reassignBooking(bookingId, partnerId) {
  try {
    const booking = await Booking.findById(bookingId);
    if (!booking) return;

    if (partnerId) {
      booking.rejectedPartners.push(partnerId);
    }

    const prevPartner = booking.partner;
    const prevAdditional = booking.get("additionalPartners") || [];

    booking.partner = null;
    booking.set("additionalPartners", [], { strict: false });
    booking.status = "PENDING_ASSIGNMENT";
    booking.assignmentAudit.push({
      stage: booking.assignmentStage || 1,
      event: "REASSIGN_REQUESTED",
      searchedPincodes: [],
      selectedPartnerId: partnerId || null,
      notes: partnerId
        ? "Reassignment triggered after partner reject/cancel"
        : "Reassignment triggered",
      candidates: [],
    });
    await booking.save();

    if (prevPartner) await syncPartnerOperationalState(prevPartner);
    for (const pId of prevAdditional) {
      await syncPartnerOperationalState(pId);
    }
    
    const prevIds = [prevPartner?.toString(), ...prevAdditional.map(id => id.toString())];
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
};
