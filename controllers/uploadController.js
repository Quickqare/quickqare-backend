function toPublicUrl(req, file) {
  const filePath = String(file.path || "");
  const isRemote = filePath.startsWith("http://") || filePath.startsWith("https://");
  const host = req.get("host");
  const configuredBaseUrl = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  return isRemote
    ? filePath
    : configuredBaseUrl
      ? `${configuredBaseUrl}/uploads/${file.filename}`
      : `${req.protocol}://${host}/uploads/${file.filename}`;
}

exports.uploadImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    res.json({
      success: true,
      imageUrl: toPublicUrl(req, req.file),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Multi-image upload (e.g. cake photo galleries). Field name "images", max 12.
exports.uploadImages = async (req, res) => {
  try {
    if (!Array.isArray(req.files) || req.files.length === 0) {
      return res.status(400).json({ success: false, message: "No files uploaded" });
    }

    res.json({
      success: true,
      imageUrls: req.files.map((file) => toPublicUrl(req, file)),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
