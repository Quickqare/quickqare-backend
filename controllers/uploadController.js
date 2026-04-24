exports.uploadImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    const filePath = String(req.file.path || "");
    const isRemote = filePath.startsWith("http://") || filePath.startsWith("https://");
    const host = req.get("host");
    const configuredBaseUrl = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
    const publicUrl = isRemote
      ? filePath
      : configuredBaseUrl
        ? `${configuredBaseUrl}/uploads/${req.file.filename}`
        : `${req.protocol}://${host}/uploads/${req.file.filename}`;

    res.json({
      success: true,
      imageUrl: publicUrl,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
