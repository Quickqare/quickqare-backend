const mongoose = require("mongoose");
const Banner = require("../models/Banner");

const asString = (value, fallback = "") => String(value ?? fallback).trim();
const normalizePlacement = (value) => asString(value || "home").toLowerCase();

const isVisibleNow = (banner, now = new Date()) => {
  if (banner?.isActive === false) return false;
  if (banner?.startsAt && new Date(banner.startsAt) > now) return false;
  if (banner?.endsAt && new Date(banner.endsAt) < now) return false;
  return true;
};

const buildPatch = (body = {}) => {
  const patch = {};
  if (body.title !== undefined) patch.title = asString(body.title);
  if (body.imageUrl !== undefined) patch.imageUrl = asString(body.imageUrl);
  if (body.linkUrl !== undefined) patch.linkUrl = asString(body.linkUrl);
  if (body.placement !== undefined) patch.placement = normalizePlacement(body.placement);
  if (body.sortOrder !== undefined) patch.sortOrder = Number(body.sortOrder) || 0;
  if (body.displayDurationSeconds !== undefined) {
    patch.displayDurationSeconds = Math.max(Number(body.displayDurationSeconds) || 5, 1);
  }
  if (body.isActive !== undefined) patch.isActive = Boolean(body.isActive);
  if (body.startsAt !== undefined) patch.startsAt = body.startsAt ? new Date(body.startsAt) : null;
  if (body.endsAt !== undefined) patch.endsAt = body.endsAt ? new Date(body.endsAt) : null;
  return patch;
};

async function listBanners({ placement = "home", activeOnly = true } = {}) {
  const query = { placement: normalizePlacement(placement) };
  if (activeOnly) query.isActive = true;
  const rows = await Banner.find(query).sort({ sortOrder: 1, createdAt: 1 }).lean();
  return activeOnly ? rows.filter((banner) => isVisibleNow(banner)) : rows;
}

exports.getPublicBanners = async (req, res) => {
  try {
    const placement = req.query.placement || "home";
    const banners = await listBanners({ placement, activeOnly: true });
    return res.json({ success: true, data: banners });
  } catch (error) {
    return res.status(500).json({
      success: false,
      data: null,
      error: { code: "BANNERS_LIST_FAILED", message: error.message || "Unable to load banners" },
    });
  }
};

exports.getAdminBanners = async (req, res) => {
  try {
    const placement = req.query.placement || "home";
    const activeOnlyRaw = req.query.activeOnly;
    const activeOnly =
      activeOnlyRaw === undefined ? false : String(activeOnlyRaw).toLowerCase() === "true";
    const banners = await listBanners({ placement, activeOnly });
    return res.json({ success: true, data: banners, error: null, meta: { requestId: req.requestId } });
  } catch (error) {
    return res.status(500).json({
      success: false,
      data: null,
      error: { code: "BANNERS_LIST_FAILED", message: "Unable to fetch banners", details: error.message },
      meta: { requestId: req.requestId },
    });
  }
};

exports.createBanner = async (req, res) => {
  try {
    const imageUrl = asString(req.body.imageUrl);
    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        data: null,
        error: { code: "VALIDATION_ERROR", message: "imageUrl is required", details: null },
        meta: { requestId: req.requestId },
      });
    }

    const row = await Banner.create({
      title: asString(req.body.title),
      imageUrl,
      linkUrl: asString(req.body.linkUrl),
      placement: normalizePlacement(req.body.placement || "home"),
      sortOrder: Number(req.body.sortOrder) || 0,
      displayDurationSeconds: Math.max(Number(req.body.displayDurationSeconds) || 5, 1),
      isActive: req.body.isActive !== undefined ? Boolean(req.body.isActive) : true,
      startsAt: req.body.startsAt ? new Date(req.body.startsAt) : null,
      endsAt: req.body.endsAt ? new Date(req.body.endsAt) : null,
      createdByAdminId: asString(req.adminUser?.id || req.adminUser?._id || ""),
      updatedByAdminId: asString(req.adminUser?.id || req.adminUser?._id || ""),
    });

    return res.json({ success: true, data: row, error: null, meta: { requestId: req.requestId } });
  } catch (error) {
    return res.status(500).json({
      success: false,
      data: null,
      error: { code: "BANNER_CREATE_FAILED", message: "Unable to create banner", details: error.message },
      meta: { requestId: req.requestId },
    });
  }
};

exports.updateBanner = async (req, res) => {
  try {
    const bannerId = asString(req.params.id);
    if (!bannerId || !mongoose.Types.ObjectId.isValid(bannerId)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: { code: "INVALID_ID", message: "Invalid banner id", details: null },
        meta: { requestId: req.requestId },
      });
    }

    const patch = buildPatch(req.body);
    patch.updatedByAdminId = asString(req.adminUser?.id || req.adminUser?._id || "");

    const row = await Banner.findByIdAndUpdate(bannerId, { $set: patch }, { new: true }).lean();
    if (!row) {
      return res.status(404).json({
        success: false,
        data: null,
        error: { code: "NOT_FOUND", message: "Banner not found", details: null },
        meta: { requestId: req.requestId },
      });
    }

    return res.json({ success: true, data: row, error: null, meta: { requestId: req.requestId } });
  } catch (error) {
    return res.status(500).json({
      success: false,
      data: null,
      error: { code: "BANNER_UPDATE_FAILED", message: "Unable to update banner", details: error.message },
      meta: { requestId: req.requestId },
    });
  }
};

exports.deleteBanner = async (req, res) => {
  try {
    const bannerId = asString(req.params.id);
    if (!bannerId || !mongoose.Types.ObjectId.isValid(bannerId)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: { code: "INVALID_ID", message: "Invalid banner id", details: null },
        meta: { requestId: req.requestId },
      });
    }

    const row = await Banner.findByIdAndDelete(bannerId).lean();
    if (!row) {
      return res.status(404).json({
        success: false,
        data: null,
        error: { code: "NOT_FOUND", message: "Banner not found", details: null },
        meta: { requestId: req.requestId },
      });
    }

    return res.json({ success: true, data: { deleted: true }, error: null, meta: { requestId: req.requestId } });
  } catch (error) {
    return res.status(500).json({
      success: false,
      data: null,
      error: { code: "BANNER_DELETE_FAILED", message: "Unable to delete banner", details: error.message },
      meta: { requestId: req.requestId },
    });
  }
};
