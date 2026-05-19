const Policy = require("../models/Policy");
const { resolveDefaultPolicy } = require("../services/policyDefaults.service");

/**
 * Get policy by type (Used by the Mobile App)
 */
const getPolicy = async (req, res) => {
  try {
    const { type } = req.params;
    const policy = await Policy.findOne({ type });
    const fallback = resolveDefaultPolicy(type);

    if (!policy) {
      if (fallback) {
        return res.json({
          success: true,
          data: {
            type: String(type || "").toLowerCase().trim(),
            title: fallback.title,
            content: fallback.content,
            lastUpdatedBy: null,
          },
        });
      }

      return res.status(404).json({
        success: false,
        message: "Policy not found",
        data: { content: "Content is being drafted by the admin." }
      });
    }

    const content = String(policy.content || "").trim() || fallback?.content || "";
    const title = String(policy.title || "").trim() || fallback?.title || type;

    res.json({
      success: true,
      data: {
        ...policy.toObject(),
        title,
        content,
      }
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
    const fallback = resolveDefaultPolicy(type);

    let policy = await Policy.findOne({ type });

    if (policy) {
      if (title) policy.title = title;
      if (content) policy.content = content;
      if (!policy.title && fallback?.title) policy.title = fallback.title;
      if (!policy.content && fallback?.content) policy.content = fallback.content;
      policy.lastUpdatedBy = adminId;
      await policy.save();
    } else {
      policy = new Policy({
        type,
        title: title || fallback?.title || type,
        content: content || fallback?.content || "",
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
