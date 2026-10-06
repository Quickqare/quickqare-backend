require("dotenv").config();
const mongoose = require("mongoose");
const Partner = require("../models/Partner");

/*
 * Converts old strike lock-outs into the new strike suspension.
 *
 * Why: until Oct 2026, reaching 5 cancellation strikes in a week set
 * isBlocked — the partner couldn't even log in, so they could neither finish
 * jobs they still held nor withdraw earnings, and nothing ever lifted it (only
 * an admin could). A strike suspension now only pauses NEW jobs
 * (isAvailable=false + suspendedUntil) and lifts by itself.
 *
 * Matches partners who carry the strike-suspension marks (suspendedUntil set,
 * 5+ weekly strikes) and are blocked but not deleted — an admin's manual block
 * never sets suspendedUntil. Review the dry-run list before applying.
 *   - suspension still running → unblock, keep the suspension until its date;
 *   - suspension already over   → unblock and make them available again.
 *
 * Dry-run by default; pass --apply to write. Safe to re-run.
 *
 * Usage: node scripts/convertStrikeBlocksToSuspensions.js [MONGO_URI] [--apply]
 */

async function main() {
  const apply = process.argv.includes("--apply");
  const uri = process.argv.slice(2).find((arg) => !arg.startsWith("--")) || process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI missing (pass it as an argument or set it in .env)");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const now = new Date();
  const partners = await Partner.find({
    isBlocked: true,
    isDeleted: { $ne: true },
    suspendedUntil: { $ne: null },
    weeklyCancelCount: { $gte: 5 },
  })
    .select("_id name phone suspendedUntil weeklyCancelCount")
    .lean();

  console.log(`${partners.length} partner(s) blocked by the old strike rule${apply ? "" : " (dry run)"}:`);
  let converted = 0;
  for (const p of partners) {
    const stillRunning = new Date(p.suspendedUntil) > now;
    console.log(
      `  ${p._id} ${p.name || ""} ${p.phone || ""} — ${p.weeklyCancelCount} strikes, suspended until ${new Date(
        p.suspendedUntil
      ).toISOString()} → ${stillRunning ? "unblock, keep suspension" : "unblock + available"}`
    );
    if (!apply) continue;

    const set = stillRunning
      ? { isBlocked: false }
      : { isBlocked: false, isAvailable: true, suspendedUntil: null };
    const res = await Partner.updateOne({ _id: p._id, isBlocked: true }, { $set: set });
    converted += res.modifiedCount || 0;
  }

  if (apply) console.log(`Converted ${converted} partner(s).`);
  else if (partners.length) console.log("Dry run — re-run with --apply to write.");

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
