/**
 * Read-only diagnostic for a QUEUED / unassigned booking.
 *
 * Usage (run on the droplet, from the backend folder):
 *   node scripts/diagnose-booking.js            # inspects the most recent QUEUED booking
 *   node scripts/diagnose-booking.js <bookingId>
 *
 * It explains WHY assignment found no partner: it resolves the hub covering the
 * booking's H3 cell, then checks every Mehendi/eligible partner against the exact
 * gates the assignment engine applies. Nothing is written.
 */
require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const Booking = require("../models/Booking");
  const Partner = require("../models/Partner");
  const Hub = require("../models/Hub");
  const AdminSetting = require("../admin/models/AdminSetting");
  const { resolveHubForH3Cell } = require("../services/zone.service");

  const arg = process.argv[2];
  const booking = arg
    ? await Booking.findById(arg).lean()
    : await Booking.findOne({ status: "QUEUED" }).sort({ createdAt: -1 }).lean();

  if (!booking) {
    console.log("No booking found.");
    return process.exit(0);
  }

  const settings = await AdminSetting.findOne().lean();
  const line = (k, v) => console.log(`  ${k.padEnd(22)}: ${v}`);

  console.log("\n=================== BOOKING ===================");
  line("_id", booking._id);
  line("status", booking.status);
  line("serviceCategory", booking.serviceCategory);
  line("services", (booking.services || []).map((s) => s.name || s.category).join(", "));
  line("pincode", booking.pincode);
  line("h3Cell", booking.h3Cell || "(none — assignment can't use hub path!)");
  line("location.coords", JSON.stringify(booking.location?.coordinates || null));
  line("scheduledStartAt", booking.scheduledStartAt);

  console.log("\n=== Last assignment audit entries (the real reason) ===");
  const audit = Array.isArray(booking.assignmentAudit) ? booking.assignmentAudit.slice(-3) : [];
  if (!audit.length) console.log("  (no audit entries)");
  for (const a of audit) {
    console.log(`  • stage ${a.stage} | ${a.event} | ${a.notes || ""}`);
    console.log(`    searchedPincodes: ${JSON.stringify(a.searchedPincodes || [])}`);
    console.log(`    candidates: ${(a.candidates || []).length}`);
  }

  console.log("\n=================== FLAGS ===================");
  line("useH3Zones", Boolean(settings?.useH3Zones));
  line("partnerVerificationRequired", Boolean(settings?.partnerVerificationRequired));

  console.log("\n=================== HUB FOR THIS BOOKING ===================");
  let hub = null;
  if (booking.h3Cell) hub = await resolveHubForH3Cell(booking.h3Cell);
  if (!hub) {
    console.log("  ❌ No hub covers this booking's H3 cell. Either no hub was drawn");
    console.log("     over this location, or the booking has no h3Cell. This alone");
    console.log("     makes hub-mode assignment return zero partners.");
  } else {
    line("hub.name", hub.name);
    line("hub._id", hub._id);
    line("hub.isActive", hub.isActive);
    line("hub.partnerAppEnabled", hub.partnerAppEnabled);
    line("hub.customerAppEnabled", hub.customerAppEnabled);
  }

  console.log("\n=================== PARTNERS (Mehendi-capable) ===================");
  const partners = await Partner.find({
    serviceCategories: { $regex: /mehendi|mehndi/i },
  }).select("name phone approvalStatus isAvailable isOnline isBlocked verificationStatus suspendedUntil assignedHubId serviceCategories skillTier").lean();

  if (!partners.length) {
    console.log("  ❌ No partner has 'mehendi' in serviceCategories. Category mismatch.");
  }

  for (const p of partners) {
    const reasons = [];
    if (p.isBlocked) reasons.push("isBlocked");
    if (p.approvalStatus !== "APPROVED") reasons.push(`approvalStatus=${p.approvalStatus}`);
    if (p.isAvailable === false) reasons.push("isAvailable=false");
    if (p.suspendedUntil && new Date(p.suspendedUntil) > new Date()) reasons.push("suspended");
    if (settings?.partnerVerificationRequired && p.verificationStatus !== "VERIFIED")
      reasons.push(`verificationStatus=${p.verificationStatus}`);
    const hubMatch = hub && String(p.assignedHubId || "") === String(hub._id);
    if (!hubMatch) reasons.push(`assignedHubId(${p.assignedHubId || "none"})≠bookingHub(${hub?._id || "none"})`);

    const ok = reasons.length === 0;
    console.log(`\n  ${ok ? "✅ ELIGIBLE" : "❌ BLOCKED"}  ${p.name} (${p.phone})`);
    line("approvalStatus", p.approvalStatus);
    line("isAvailable / isOnline", `${p.isAvailable} / ${p.isOnline}`);
    line("verificationStatus", p.verificationStatus);
    line("assignedHubId", p.assignedHubId || "(none)");
    line("serviceCategories", JSON.stringify(p.serviceCategories));
    if (!ok) console.log(`    → blocked by: ${reasons.join(", ")}`);
  }

  console.log("\n===============================================\n");
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error("diagnose error:", e);
  process.exit(1);
});
