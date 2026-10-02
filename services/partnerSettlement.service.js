const mongoose = require("mongoose");
const Service = require("../models/service.model");
const WalletTransaction = require("../models/WalletTransaction");

/* =====================================================
   PARTNER SETTLEMENT
   What a booking pays its partner(s) after platform commission. The same
   numbers drive the wallet credit at completion (booking.controller
   completeBooking) and the earnings the partner app shows on job cards, so
   the two can never disagree.
===================================================== */

const roundAmount = (value) =>
  Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const clampPercent = (value, fallback = 20) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, 0), 100);
};

// services[].serviceId may be a raw ObjectId or a populated Service doc.
const idOf = (value) => String(value?._id || value || "");

/*
  Approved AND PAID on-site estimate items are part of the partner's delivered
  work — settle them exactly like booking lines (commission per item's service,
  falling back to the partner's own rate). Estimates that were approved but
  never paid contribute nothing: crediting a partner for money the platform
  never collected would leak funds.
*/
const calculateEstimateSettlement = async (booking, partner) => {
  const paid =
    booking.estimateStatus === "approved" &&
    booking.estimatePayment?.status === "PAID" &&
    Array.isArray(booking.estimateItems) &&
    booking.estimateItems.length > 0;

  if (!paid) return { grossAmount: 0, commissionAmount: 0 };

  // Estimate line items reference CatalogItem records (see submitEstimate),
  // which carry no per-item commission — so commission on approved estimate
  // work is charged at the partner's own rate. A previous version queried the
  // Service collection with these CatalogItem ids, which never matched and
  // silently produced this exact fallback for every item; the dead lookup is
  // removed so the behaviour is explicit (and one DB round-trip is saved).
  const commissionPercent = clampPercent(partner?.commissionPercent, 20);

  let grossAmount = 0;
  let commissionAmount = 0;
  for (const item of booking.estimateItems) {
    const lineTotal = roundAmount(Number(item.lineTotal || 0));
    if (lineTotal <= 0) continue;
    grossAmount = roundAmount(grossAmount + lineTotal);
    commissionAmount = roundAmount(
      commissionAmount + roundAmount((lineTotal * commissionPercent) / 100)
    );
  }

  return {
    grossAmount,
    commissionAmount: Math.min(commissionAmount, grossAmount),
  };
};

// `serviceCommissions` (optional Map<serviceId, commissionPercent|undefined>)
// lets a caller settling many bookings pre-load Service rows in one query.
const loadServiceCommissions = async (ids, serviceCommissions) => {
  const map = new Map();
  const missing = [];
  for (const id of ids) {
    if (serviceCommissions?.has(id)) map.set(id, { commissionPercent: serviceCommissions.get(id) });
    else missing.push(id);
  }
  if (missing.length) {
    const rows = await Service.find({ _id: { $in: missing } }).select("commissionPercent").lean();
    for (const row of rows) map.set(String(row._id), row);
  }
  return map;
};

const calculatePartnerSettlement = async (booking, partner, { serviceCommissions } = {}) => {
  const taxableAmount = Math.max(
    roundAmount(Number(booking.baseAmount || 0) - Number(booking.discountAmount || 0)),
    0
  );

  const estimate = await calculateEstimateSettlement(booking, partner);

  const bookingLines = Array.isArray(booking.services) ? booking.services : [];

  if (bookingLines.length) {
    const lineTotalBase = bookingLines.reduce(
      (sum, item) => sum + Number(item.lineTotal || 0),
      0
    );
    const discountFactor =
      lineTotalBase > 0 ? taxableAmount / lineTotalBase : 1;

    const validIds = bookingLines
      .map((item) => idOf(item.serviceId))
      .filter((id) => mongoose.Types.ObjectId.isValid(id));

    const serviceMap = await loadServiceCommissions(validIds, serviceCommissions);

    let commissionAmount = 0;

    for (const item of bookingLines) {
      const lineTotal = roundAmount(Number(item.lineTotal || 0) * discountFactor);
      const commissionPercent = clampPercent(
        serviceMap.get(idOf(item.serviceId))?.commissionPercent,
        clampPercent(partner?.commissionPercent, 20)
      );
      commissionAmount += roundAmount((lineTotal * commissionPercent) / 100);
    }

    commissionAmount = Math.min(roundAmount(commissionAmount), taxableAmount);

    return {
      grossAmount: roundAmount(taxableAmount + estimate.grossAmount),
      commissionAmount: roundAmount(commissionAmount + estimate.commissionAmount),
      partnerEarningAmount: roundAmount(
        taxableAmount - commissionAmount + estimate.grossAmount - estimate.commissionAmount
      ),
    };
  }

  let commissionPercent = clampPercent(partner?.commissionPercent, 20);
  if (booking.serviceId && mongoose.Types.ObjectId.isValid(idOf(booking.serviceId))) {
    const serviceMap = await loadServiceCommissions([idOf(booking.serviceId)], serviceCommissions);
    const service = serviceMap.get(idOf(booking.serviceId));
    commissionPercent = clampPercent(service?.commissionPercent, commissionPercent);
  }

  const commissionAmount = roundAmount((taxableAmount * commissionPercent) / 100);
  return {
    grossAmount: roundAmount(taxableAmount + estimate.grossAmount),
    commissionAmount: roundAmount(commissionAmount + estimate.commissionAmount),
    partnerEarningAmount: roundAmount(
      taxableAmount - commissionAmount + estimate.grossAmount - estimate.commissionAmount
    ),
  };
};

/*
  A partner's slice of a booking's settlement — mirrors how completeBooking
  splits the credit: the partner's teamAllocations payoutRatio when the booking
  has allocations, otherwise an equal split across the primary partner and any
  additionalPartners.
*/
const partnerShareRatio = (booking, partnerId) => {
  const pid = String(partnerId || "");
  const allocations = Array.isArray(booking?.teamAllocations) ? booking.teamAllocations : [];
  if (allocations.length) {
    const mine = allocations.find((a) => idOf(a.partnerId) === pid);
    return mine ? Number(mine.payoutRatio || 0) : 0;
  }
  const additional = Array.isArray(booking?.additionalPartners) ? booking.additionalPartners : [];
  return 1 / (1 + additional.length);
};

/*
  What each booking pays THIS partner, for the partner app's job cards:
  - completed work → the amount actually credited to their wallet
    (job_payment ledger row), so the card matches the wallet exactly;
  - everything else → settlement × their share, i.e. what completion will
    credit. Commission falls back to the booking's primary partner's rate,
    exactly like completeBooking.
  `bookings` are lean docs or documents, with `partner` populated or a raw id.
  Returns Map<bookingId, amount>.
*/
const partnerEarningsFor = async (bookings, partnerId) => {
  const Partner = require("../models/Partner");
  const list = Array.isArray(bookings) ? bookings : [];
  if (!list.length) return new Map();

  const credited = await WalletTransaction.find({
    partnerId,
    bookingId: { $in: list.map((b) => b._id) },
    reason: "job_payment",
    type: "credit",
  })
    .select("bookingId amount")
    .lean();
  const creditedMap = new Map(credited.map((t) => [String(t.bookingId), roundAmount(t.amount)]));

  // Primary partners' commission rates, in one query (unless already populated).
  const isPopulated = (p) => p && typeof p === "object" && "commissionPercent" in p;
  const primaryIds = [...new Set(list.filter((b) => !isPopulated(b.partner)).map((b) => idOf(b.partner)))]
    .filter((id) => mongoose.Types.ObjectId.isValid(id));
  const primaries = primaryIds.length
    ? await Partner.find({ _id: { $in: primaryIds } }).select("commissionPercent").lean()
    : [];
  const primaryMap = new Map(primaries.map((p) => [String(p._id), p]));

  // Every service referenced by these bookings, in one query.
  const serviceIds = [
    ...new Set(
      list.flatMap((b) => [
        ...(Array.isArray(b.services) ? b.services.map((s) => idOf(s.serviceId)) : []),
        idOf(b.serviceId),
      ])
    ),
  ].filter((id) => mongoose.Types.ObjectId.isValid(id));
  const serviceRows = serviceIds.length
    ? await Service.find({ _id: { $in: serviceIds } }).select("commissionPercent").lean()
    : [];
  const serviceCommissions = new Map(serviceIds.map((id) => [id, undefined]));
  for (const row of serviceRows) serviceCommissions.set(String(row._id), row.commissionPercent);

  const result = new Map();
  for (const booking of list) {
    const key = String(booking._id);
    if (creditedMap.has(key)) {
      result.set(key, creditedMap.get(key));
      continue;
    }
    const primary = isPopulated(booking.partner) ? booking.partner : primaryMap.get(idOf(booking.partner));
    const settlement = await calculatePartnerSettlement(booking, primary, { serviceCommissions });
    result.set(key, roundAmount(settlement.partnerEarningAmount * partnerShareRatio(booking, partnerId)));
  }
  return result;
};

module.exports = {
  calculatePartnerSettlement,
  calculateEstimateSettlement,
  partnerShareRatio,
  partnerEarningsFor,
};
