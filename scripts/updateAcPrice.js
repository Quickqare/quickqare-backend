require("dotenv").config();
const mongoose = require("mongoose");
const Service = require("../models/service.model");

async function run() {
  const uri = process.env.MONGO_URI || process.argv[2];
  if (!uri) {
    console.error("Usage: node scripts/updateAcPrice.js <MONGO_URI>");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const result = await Service.updateMany(
    {
      $or: [
        { name: { $regex: /ac\s*deep\s*clean/i } },
        { slug: { $regex: /ac.*deep.*clean/ } },
      ],
      price: 749,
    },
    { $set: { price: 549 } }
  );

  if (result.matchedCount === 0) {
    // Broader search — any AC service priced at 749
    const broader = await Service.updateMany(
      { name: { $regex: /ac/i }, price: 749 },
      { $set: { price: 549 } }
    );
    console.log(
      broader.matchedCount === 0
        ? "No AC service with price 749 found. Check the DB manually."
        : `Updated ${broader.modifiedCount} AC service(s) from ₹749 → ₹549`
    );
  } else {
    console.log(`Updated ${result.modifiedCount} service(s) from ₹749 → ₹549`);
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
