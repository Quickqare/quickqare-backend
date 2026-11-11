/**
 * Admin-set booking window: Partner.minLeadDays / availableFrom keep a partner
 * out of matching for dates before their cutoff.
 */
const Partner = require("../models/Partner");
const Category = require("../models/Category");
const Service = require("../models/service.model");
const { findEligiblePartnersForBooking } = require("../services/scheduling_service");

const PINCODE = "700001";

function dayKey(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function setup() {
  const cat = await Category.create({ name: "Salon for Women", slug: "salon-for-women" });
  const svc = await Service.create({ name: "Waxing", price: 299, category: cat._id, duration: 45 });
  const mk = (overrides) =>
    Partner.create({
      name: "P",
      phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
      password: "x",
      approvalStatus: "APPROVED",
      serviceAreas: [PINCODE],
      services: [{ serviceId: svc._id, name: svc.name, isActive: true }],
      ...overrides,
    });
  const ids = async (offset) => {
    const ranked = await findEligiblePartnersForBooking(
      {
        services: [{ serviceId: svc._id, quantity: 1 }],
        scheduledDate: dayKey(offset),
        scheduledTime: "10:00",
        pincode: PINCODE,
        rejectedPartners: [],
      },
      [PINCODE],
      { requireOnline: false }
    );
    return ranked.map((e) => String(e.partner._id));
  };
  return { mk, ids };
}

test("minLeadDays hides the partner on days inside the notice period", async () => {
  const { mk, ids } = await setup();
  const free = await mk({});
  const lead1 = await mk({ minLeadDays: 1 });
  expect(await ids(0)).toEqual([String(free._id)]);
  expect((await ids(1)).sort()).toEqual([String(free._id), String(lead1._id)].sort());
});

test("availableFrom hides the partner before that date only", async () => {
  const { mk, ids } = await setup();
  const [y, m, d] = dayKey(3).split("-").map(Number);
  const p = await mk({ availableFrom: new Date(y, m - 1, d) });
  expect(await ids(2)).toEqual([]);
  expect(await ids(3)).toEqual([String(p._id)]);
  expect(await ids(4)).toEqual([String(p._id)]);
});
