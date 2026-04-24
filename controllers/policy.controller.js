const Policy = require("../models/Policy");

/**
 * Get policy by type (Used by the Mobile App)
 */
const getPolicy = async (req, res) => {
  try {
    const { type } = req.params;
    const policy = await Policy.findOne({ type });

    if (!policy) {
      return res.status(404).json({
        success: false,
        message: "Policy not found",
        data: { content: "Content is being drafted by the admin." }
      });
    }

    res.json({
      success: true,
      data: policy
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to get policy" });
  }
};

/**
 * Update or create policy (Used by the Admin Panel)
 */
const updatePolicy = async (req, res) => {
  try {
    const { type } = req.params;
    const { title, content } = req.body;
    const adminId = req.user ? req.user.id : null; 

    let policy = await Policy.findOne({ type });

    if (policy) {
      if (title) policy.title = title;
      if (content) policy.content = content;
      policy.lastUpdatedBy = adminId;
      await policy.save();
    } else {
      policy = new Policy({
        type,
        title: title || type,
        content,
        lastUpdatedBy: adminId
      });
      await policy.save();
    }

    res.json({ success: true, message: "Policy updated successfully", data: policy });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to update policy" });
  }
};

module.exports = {
  getPolicy,
  updatePolicy
};