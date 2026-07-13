// Build a public URL for a freshly uploaded file, regardless of storage backend.
//
//   - Cloudflare R2 (multer-s3): file.location holds the internal S3-style URL and
//     file.key the object key. R2 buckets aren't publicly reachable at that endpoint,
//     so we prefer R2_PUBLIC_URL (the bucket's public/custom domain) + key. We fall
//     back to file.location only if R2_PUBLIC_URL isn't configured.
//   - Any storage that returns a fully-qualified https URL in file.path is passed
//     through as-is.
//   - Local disk (USE_LOCAL_UPLOADS): build from PUBLIC_BASE_URL (or the request host)
//     + /uploads/<filename>.
//
// Keep this the single source of truth — every upload handler should call it rather
// than re-deriving the URL, so switching storage backends is a one-file change.
function fileToPublicUrl(req, file) {
  if (!file) return "";

  // R2 / any S3-compatible store via multer-s3
  if (file.location) {
    const key = file.key || file.Key || "";
    const publicBase = String(process.env.R2_PUBLIC_URL || "").trim().replace(/\/+$/, "");
    return publicBase && key ? `${publicBase}/${key}` : file.location;
  }

  // Any backend that hands back a fully-qualified https URL in file.path
  const filePath = String(file.path || "");
  if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
    return filePath;
  }

  // Local disk
  const configuredBaseUrl = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  const base = configuredBaseUrl || `${req.protocol}://${req.get("host")}`;
  return `${base}/uploads/${file.filename}`;
}

module.exports = { fileToPublicUrl };
