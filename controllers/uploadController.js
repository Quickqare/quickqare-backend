const { fileToPublicUrl } = require("../utils/fileUrl");

exports.uploadImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    res.json({
      success: true,
      imageUrl: fileToPublicUrl(req, req.file),
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
      imageUrls: req.files.map((file) => fileToPublicUrl(req, file)),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
