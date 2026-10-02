require("dotenv").config();
const mongoose = require("mongoose");
const Category = require("../models/Category");
const Partner = require("../models/Partner");
const Policy = require("../models/Policy");
const { resolveDefaultPolicy } = require("../services/policyDefaults.service");

/*
 * Turns on the women-only partner rule (Category.partnerGender = FEMALE) for
 * the women's salon / self-care categories, tags them categoryType SALON
 * (skill-tier gate + visit-window team split, rename-safe), and brings the
 * stored Anti-discrimination Policy §4 in line with the rule.
 *
 * DRY RUN by default — prints what would change and which partners serving
 * these categories would stop matching (gender not FEMALE). Nothing is
 * written without --apply. --apply refuses when a category's approved
 * partners include no woman (every booking would go unassigned) unless
 * --force.
 *
 * The stored policy is only rewritten while its §4 still matches the
 * original default text; an admin-edited §4 is reported for manual update
 * (admin panel → Policies) instead of being overwritten.
 *
 * Usage:
 *   node scripts/enableWomenOnlyCategories.js [MONGO_URI] [--apply] [--force]
 *     [--categories="Salon for Women,Hair Studio for Women"]
 */

const DEFAULT_CATEGORY_NAMES = [
  "Salon for Women",
  "Hair Studio for Women",
  "Makeup, Saree & Styling",
];

// §4 exactly as shipped before the women-only carve-out.
const ORIGINAL_SECTION_4 = `4. How QuickQare assigns jobs
   Job assignment is driven by service category, location, availability, and partner rating — never by a customer's or partner's protected characteristics. QuickQare does not collect or use religion, caste, or similar data in its matching or ranking logic.`;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function newSection4() {
  const content = resolveDefaultPolicy("anti_discrimination")?.content || "";
  const match = content.match(/4\. How QuickQare assigns jobs[\s\S]*?(?=\n\n5\. )/);
  if (!match) throw new Error("Default anti_discrimination policy has no §4 — check policyDefaults.service.js");
  return match[0];
}

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--") && !a.includes("=")));
  const catArg = argv.find((a) => a.startsWith("--categories="));
  const uri = process.env.MONGO_URI || argv.find((a) => !a.startsWith("--"));
  return {
    uri,
    apply: flags.has("--apply"),
    force: flags.has("--force"),
    categoryNames: catArg
      ? catArg.slice("--categories=".length).split(",").map((s) => s.trim()).filter(Boolean)
      : DEFAULT_CATEGORY_NAMES,
  };
}

async function run() {
  const { uri, apply, force, categoryNames } = parseArgs(process.argv.slice(2));
  if (!uri) {
    console.error("Usage: node scripts/enableWomenOnlyCategories.js <MONGO_URI> [--apply] [--force]");
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log(apply ? "== APPLY MODE ==" : "== DRY RUN (pass --apply to write) ==");

  const categories = await Category.find({
    name: { $in: categoryNames.map((n) => new RegExp(`^${escapeRegex(n)}$`, "i")) },
  }).lean();

  const found = new Set(categories.map((c) => c.name.toLowerCase()));
  for (const name of categoryNames) {
    if (!found.has(name.toLowerCase())) console.log(`! Category not found: "${name}" — skipped`);
  }

  let blocked = false;
  for (const cat of categories) {
    const partners = await Partner.find({
      $or: [
        { serviceCategories: new RegExp(`^${escapeRegex(cat.name)}$`, "i") },
        // services[].category is a String snapshot (id or name)
        { "services.category": { $in: [String(cat._id), new RegExp(`^${escapeRegex(cat.name)}$`, "i")] } },
      ],
    })
      .select("name phone gender approvalStatus isBlocked")
      .lean();

    const approved = partners.filter((p) => p.approvalStatus === "APPROVED" && !p.isBlocked);
    const female = approved.filter((p) => p.gender === "FEMALE");
    const wouldDrop = approved.filter((p) => p.gender !== "FEMALE");

    console.log(`\n# ${cat.name}`);
    console.log(`  now: partnerGender=${cat.partnerGender || "ANY"} categoryType=${cat.categoryType || "GENERAL"}`);
    console.log(`  approved partners: ${approved.length} (female ${female.length}, would stop matching ${wouldDrop.length})`);
    for (const p of wouldDrop) {
      const phone = String(p.phone || "");
      console.log(`    - ${p.name || "(no name)"} ****${phone.slice(-4)} gender=${p.gender || "NOT SET"} id=${p._id}`);
    }
    if (approved.length && !female.length) {
      console.log("  ! No approved female partner — every booking in this category would go unassigned.");
      blocked = true;
    }
  }

  const policy = await Policy.findOne({ type: "anti_discrimination" }).lean();
  let policyAction;
  if (!policy) {
    policyAction = "none stored — the updated code default is served after deploy";
  } else if (policy.content.includes(ORIGINAL_SECTION_4)) {
    policyAction = "stored §4 is the original default — will replace with the women-only carve-out";
  } else if (policy.content.includes("delivered only by women professionals")) {
    policyAction = "stored policy already has the carve-out — no change";
  } else {
    policyAction = "stored §4 was edited by an admin — NOT touched; add the carve-out manually (admin → Policies)";
  }
  console.log(`\nPolicy: ${policyAction}`);

  if (!apply) {
    console.log("\nDry run complete. Fix partner genders above (admin → Partners → Gender), then re-run with --apply.");
    await mongoose.disconnect();
    return;
  }
  if (blocked && !force) {
    console.error("\nRefusing to apply: a category has no approved female partner. Re-run with --force to apply anyway.");
    await mongoose.disconnect();
    process.exit(1);
  }

  // Policy first: the rule must never be live without the policy text.
  if (policy && policy.content.includes(ORIGINAL_SECTION_4)) {
    await Policy.updateOne(
      { _id: policy._id },
      { $set: { content: policy.content.replace(ORIGINAL_SECTION_4, newSection4()) } }
    );
    console.log("Policy §4 updated.");
  }

  for (const cat of categories) {
    const set = { partnerGender: "FEMALE" };
    if (!cat.categoryType || cat.categoryType === "GENERAL") set.categoryType = "SALON";
    await Category.updateOne({ _id: cat._id }, { $set: set });
    console.log(`Updated "${cat.name}": ${JSON.stringify(set)}`);
  }

  console.log("\nDone. Slot listings pick this up within the 30s slot cache.");
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
