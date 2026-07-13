/* =====================================================
   SIGNED URLs FOR SENSITIVE UPLOADS (partner selfies / KYC)
   =====================================================
   Public media (service images, banners) is served from a public R2 bucket by
   design — the customer app shows it without auth. Sensitive uploads (partner
   selfies, and any identity documents) must NOT be world-readable at a guessable
   URL just because they live on the same bucket.

   How to actually make them private (infra + this flag):
     1. Host sensitive objects on a PRIVATE R2 bucket/prefix (no public r2.dev
        domain, no public custom domain).
     2. Set R2_PRIVATE_UPLOADS=true and point R2_PUBLIC_URL at that bucket's
        endpoint so the stored URL can be reverse-mapped to an object key.
   With the flag OFF (default) this returns the stored URL unchanged, so
   existing deployments behave exactly as before until the private bucket is set
   up — no data migration, no breakage.

   When ON, this converts a stored public URL back to its object key and returns
   a short-lived pre-signed GET URL that only an authenticated admin/partner
   response hands out.
========================================================= */

const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const r2Client = require("../config/r2");

const SIGNED_URL_TTL_SECONDS = Number(process.env.R2_SIGNED_URL_TTL_SECONDS || 900); // 15 min

const isPrivateMode = () =>
  String(process.env.R2_PRIVATE_UPLOADS || "").toLowerCase() === "true";

function publicBase() {
  return String(process.env.R2_PUBLIC_URL || "").trim().replace(/\/+$/, "");
}

// Reverse-map a stored public URL ("<R2_PUBLIC_URL>/selfies/123.jpg") to its
// bucket object key ("selfies/123.jpg"). Returns null if the URL isn't an R2
// public URL we recognise (e.g. a legacy Cloudinary URL) — caller then leaves
// it untouched.
function keyFromUrl(url) {
  const base = publicBase();
  if (!base || typeof url !== "string") return null;
  if (!url.startsWith(base + "/")) return null;
  return url.slice(base.length + 1);
}

/**
 * Given a stored file URL, return a URL safe to hand to an authenticated client.
 *   - private mode OFF  → the URL unchanged (current behaviour)
 *   - private mode ON   → a short-lived pre-signed GET URL when the object lives
 *                         on our R2 bucket; otherwise the URL unchanged.
 */
async function getSensitiveFileUrl(url) {
  if (!url || !isPrivateMode()) return url;

  const key = keyFromUrl(url);
  if (!key) return url;

  try {
    return await getSignedUrl(
      r2Client,
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }),
      { expiresIn: SIGNED_URL_TTL_SECONDS }
    );
  } catch (err) {
    // Signing failure must not break the response — fall back to the stored URL.
    // eslint-disable-next-line no-console
    console.error("[sensitive-url] presign failed:", err.message);
    return url;
  }
}

module.exports = { getSensitiveFileUrl };
