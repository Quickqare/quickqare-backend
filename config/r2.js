const { S3Client } = require("@aws-sdk/client-s3");

// R2 buckets created in a specific jurisdiction (e.g. EU) live at a
// jurisdiction-specific endpoint. Set R2_JURISDICTION=eu for EU buckets;
// leave it unset/empty for the default (standard) jurisdiction.
const jurisdiction = String(process.env.R2_JURISDICTION || "").trim().toLowerCase();
const host = jurisdiction
  ? `${process.env.R2_ACCOUNT_ID}.${jurisdiction}.r2.cloudflarestorage.com`
  : `${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${host}`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

module.exports = r2Client;
