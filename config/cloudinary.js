const { v2: cloudinary } = require("cloudinary");

const cloudName = process.env.CLOUDINARY_NAME || process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_SECRET;

// Fail loud at startup when Cloudinary is the active upload backend but creds
// are missing — otherwise every /api/upload fails at request time with an
// opaque 500 ("Must supply api_key"). We log instead of throwing so the rest
// of the API stays up; uploads simply won't work until creds are set.
const useLocalUploads = String(process.env.USE_LOCAL_UPLOADS || "").toLowerCase() === "true";
if (!useLocalUploads && (!cloudName || !apiKey || !apiSecret)) {
  const missing = [
    !cloudName && "CLOUDINARY_NAME (or CLOUDINARY_CLOUD_NAME)",
    !apiKey && "CLOUDINARY_API_KEY",
    !apiSecret && "CLOUDINARY_SECRET",
  ].filter(Boolean).join(", ");
  console.error(
    `🔥 [cloudinary] Image uploads are BROKEN: missing ${missing}. ` +
    `Set these on the server, or set USE_LOCAL_UPLOADS=true for local disk storage.`
  );
}

cloudinary.config({
  cloud_name: cloudName,
  api_key: apiKey,
  api_secret: apiSecret,
  secure: true,
});

module.exports = cloudinary;
