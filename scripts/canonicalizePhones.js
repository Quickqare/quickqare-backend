require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");
const Partner = require("../models/Partner");
const Booking = require("../models/Booking");
const { toNationalPhone } = require("../utils/phone");

/*
 * Rewrites every customer/partner phone to the canonical 10-digit national
 * number (utils/phone) — the form every account lookup now uses.
 *
 * Why: until the Sept 2026 fix, accounts were found/created by the raw request
 * string while MSG91 normalised it, so "9876543210" and "+91 98765 43210" could
 * be two accounts on one real phone. Lookups are now canonical, so a row still
 * stored in another format would no longer be found at login and its owner
 * would silently get a fresh account. Every official client already sends the
 * bare 10-digit number, so expect few or no rows to change.
 *
 * Per row:
 *   - the only account for its number      → rewritten to canonical (--apply)
 *   - another account has the same number  → CONFLICT, left untouched: these are
 *     duplicate accounts on one phone and need a manual merge decision
 *     (bookings / wallet / referrals hang off each _id)
 *   - not a parseable 10-digit number      → UNPARSEABLE, left untouched
 * Soft-deleted accounts ("deleted_<id>") are skipped.
 *
 * Run it right after deploying the canonical-phone code. Dry-run by default;
 * pass --apply to write.
 *
 * Usage: node scripts/canonicalizePhones.js [MONGO_URI] [--apply]
 */

async function canonicalizeCollection(Model, label, bookingField, apply) {
  const groups = new Map(); // canonical number -> every account holding it
  const unparseable = [];

  const cursor = Model.find({ phone: { $not: /^deleted_/ } })
    .select("phone createdAt")
    .lean()
    .cursor();
  for await (const row of cursor) {
    const canonical = toNationalPhone(row.phone);
    if (!canonical) {
      unparseable.push(row);
      continue;
    }
    if (!groups.has(canonical)) groups.set(canonical, []);
    groups.get(canonical).push(row);
  }

  let rewritten = 0;
  let conflicts = 0;

  for (const [canonical, rows] of groups) {
    if (rows.every((row) => row.phone === canonical)) continue;

    if (rows.length > 1) {
      conflicts += 1;
      console.log(`[${label}] CONFLICT ${canonical} — ${rows.length} accounts share this phone:`);
      for (const row of rows) {
        const bookings = await Booking.countDocuments({ [bookingField]: row._id });
        console.log(
          `    ${row._id}  phone=${JSON.stringify(row.phone)}  ` +
            `created=${row.createdAt ? row.createdAt.toISOString() : "?"}  bookings=${bookings}`
        );
      }
      continue;
    }

    const [row] = rows;
    console.log(
      `[${label}] ${row._id}: ${JSON.stringify(row.phone)} -> ${canonical}` +
        (apply ? "" : " (dry-run)")
    );
    if (apply) {
      try {
        // Guarded on the value we read, so a concurrent edit is never clobbered.
        await Model.updateOne({ _id: row._id, phone: row.phone }, { $set: { phone: canonical } });
      } catch (err) {
        // E11000: someone signed up on this number since the scan — a conflict now.
        if (err?.code !== 11000) throw err;
        conflicts += 1;
        console.log(`[${label}] CONFLICT ${canonical} — created concurrently; ${row._id} left as is`);
        continue;
      }
    }
    rewritten += 1;
  }

  for (const row of unparseable) {
    console.log(`[${label}] UNPARSEABLE ${row._id}: phone=${JSON.stringify(row.phone)} — left as is`);
  }

  console.log(
    `[${label}] ${rewritten} rewritten${apply ? "" : " (dry-run)"}, ` +
      `${conflicts} conflict(s) to merge manually, ${unparseable.length} unparseable.`
  );
}

async function run() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const uri = process.env.MONGO_URI || args.find((a) => !a.startsWith("--"));
  if (!uri) {
    console.error("Usage: node scripts/canonicalizePhones.js <MONGO_URI> [--apply]");
    process.exit(1);
  }
  await mongoose.connect(uri);

  await canonicalizeCollection(User, "user", "user", apply);
  await canonicalizeCollection(Partner, "partner", "partner", apply);

  if (!apply) console.log("Dry-run — pass --apply to write.");
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
