const express = require("express");
const AdminSetting = require("../admin/models/AdminSetting");

const router = express.Router();

const DEFAULT_THEME = {
  isActive: false,
  themeName: "default",
  primaryColor: "#0A0A0A",
  accentColor: "#FFFFFF",
  backgroundColor: "#F5F5F5",
  promoTagBadge: "LIMITED OFFER",
  promoTagline: "",
  promoCta: "Book now  →",
};

/**
 * GET /api/app-config
 * Public — no auth required.
 * Returns the currently active home-screen theme so the
 * customer app can apply festival / campaign colours.
 */
router.get("/", async (_req, res) => {
  try {
    const settings = await AdminSetting.findOne().lean();
    const theme = settings?.homeTheme ?? DEFAULT_THEME;

    return res.json({
      success: true,
      homeTheme: {
        isActive:        Boolean(theme.isActive),
        themeName:       theme.themeName       || DEFAULT_THEME.themeName,
        primaryColor:    theme.primaryColor    || DEFAULT_THEME.primaryColor,
        accentColor:     theme.accentColor     || DEFAULT_THEME.accentColor,
        backgroundColor: theme.backgroundColor || DEFAULT_THEME.backgroundColor,
        promoTagBadge:   theme.promoTagBadge   || DEFAULT_THEME.promoTagBadge,
        promoTagline:    theme.promoTagline     || DEFAULT_THEME.promoTagline,
        promoCta:        theme.promoCta        || DEFAULT_THEME.promoCta,
      },
    });
  } catch (err) {
    // On any error, return the default so the app never crashes
    return res.json({ success: true, homeTheme: DEFAULT_THEME });
  }
});

module.exports = router;
