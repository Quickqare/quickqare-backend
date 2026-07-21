/**
 * One-shot backfill: sets Service.skillTier (AC) and Service.packingRole
 * (mehendi) on EXISTING rows by matching names against the default catalog.
 * New deployments get these from seed-defaults; this script covers services
 * created before the fields existed. Idempotent — only touches rows where
 * the value would actually change, and never overwrites an explicit value
 * an admin already set differently (pass --force to overwrite anyway).
 *
 * Usage: node scripts/backfillServiceRoles.js <MONGO_URI> [--force]
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Service = require("../models/service.model");
const defaultServices = require("../admin/data/defaultServices");

async function run() {
  const args = process.argv.slice(2).filter((a) => a !== "--force");
  const force = process.argv.includes("--force");
  const uri = process.env.MONGO_URI || args[0];
  if (!uri) {
    console.error("Usage: node scripts/backfillServiceRoles.js <MONGO_URI> [--force]");
    process.exit(1);
  }
  await mongoose.connect(uri);

  let tierUpdates = 0;
  let roleUpdates = 0;
  let skipped = 0;

  for (const def of defaultServices) {
    const wantsTier = [1, 2].includes(Number(def.skillTier));
    const wantsRole = typeof def.packingRole === "string" && def.packingRole;
    if (!wantsTier && !wantsRole) continue;

    const row = await Service.findOne({
      name: new RegExp(`^${def.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    });
    if (!row) {
      skipped += 1;
      console.log(`  - not in DB: "${def.name}"`);
      continue;
    }

    const set = {};
    if (wantsTier && Number(row.skillTier || 1) !== Number(def.skillTier)) {
      // skillTier defaults to 1 in the schema; a stored 2 that differs from
      // the catalog means an admin chose it — keep unless --force.
      if (Number(row.skillTier) === 2 && !force) {
        console.log(`  - keeping admin-set skillTier=2 on "${row.name}"`);
      } else {
        set.skillTier = Number(def.skillTier);
      }
    }
    if (wantsRole && row.packingRole !== def.packingRole) {
      if (row.packingRole && !force) {
        console.log(`  - keeping admin-set packingRole=${row.packingRole} on "${row.name}"`);
      } else {
        set.packingRole = def.packingRole;
      }
    }

    if (Object.keys(set).length) {
      await Service.updateOne({ _id: row._id }, { $set: set });
      if (set.skillTier !== undefined) tierUpdates += 1;
      if (set.packingRole !== undefined) roleUpdates += 1;
      console.log(`  ✓ "${row.name}" → ${JSON.stringify(set)}`);
    }
  }

  console.log(
    `Done. skillTier set on ${tierUpdates} service(s), packingRole on ${roleUpdates}; ${skipped} catalog name(s) not found in DB.`
  );
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
