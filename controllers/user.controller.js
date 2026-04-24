const User = require("../models/User");

/**
 * Update user profile (name and gender)
 * Limited to 3 times per year
 */
const updateProfile = async (req, res) => {
  try {
    const { name, gender } = req.body;
    const userId = req.user.id;

    // Validate input
    if (!name || !gender) {
      return res.status(400).json({
        success: false,
        message: "Name and gender are required"
      });
    }

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Check edit limit (3 times per year)
    const currentYear = new Date().getFullYear();
    const editsThisYear = user.profileEdits.filter(edit => {
      return new Date(edit.date).getFullYear() === currentYear;
    });

    if (editsThisYear.length >= 3) {
      return res.status(429).json({
        success: false,
        message: "You can only edit your profile 3 times per year"
      });
    }

    // Track the changes
    const changes = {};
    if (user.name !== name) changes.name = { from: user.name, to: name };
    if (user.gender !== gender) changes.gender = { from: user.gender, to: gender };

    // Update user
    user.name = name;
    user.gender = gender;
    user.profileEdits.push({
      date: new Date(),
      changes,
    });

    await user.save();

    // Return updated user (without sensitive data)
    const updatedUser = {
      id: user._id,
      name: user.name,
      gender: user.gender,
      phone: user.phone,
      email: user.email,
    };

    res.json({
      success: true,
      message: "Profile updated successfully",
      data: { user: updatedUser }
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update profile"
    });
  }
};

/**
 * Get user profile edit history
 */
const getProfileEditHistory = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId).select("profileEdits");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Calculate remaining edits for current year
    const currentYear = new Date().getFullYear();
    const editsThisYear = user.profileEdits.filter(edit => {
      return new Date(edit.date).getFullYear() === currentYear;
    });

    res.json({
      success: true,
      message: "Profile edit history retrieved",
      data: {
        editsThisYear: editsThisYear.length,
        remainingEdits: Math.max(0, 3 - editsThisYear.length),
        history: user.profileEdits,
      }
    });
  } catch (error) {
    console.error("Get profile edit history error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get profile edit history"
    });
  }
};

module.exports = {
  updateProfile,
  getProfileEditHistory,
};