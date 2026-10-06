/**
 * "Who will receive the service?" (customer-app audit, Oct 2026, item 16).
 *
 * The customer app asks for the name and phone number of whoever will be at the
 * address — "Myself" or "Someone else" — and then threw the answer away: the
 * server never stored it, so the professional called the person who booked, not
 * the one at the door. Now it is saved with the address, copied onto the booking,
 * and shown to the professional as "the customer" in every payload the partner
 * apps read (so they need no change).
 */
jest.mock("../services/pushNotification.service", () => ({
  notifyPartner: jest.fn(),
  notifyCustomerOfBookingStatus: jest.fn(),
  sendJobCancelledPush: jest.fn(),
  sendJobAssignedPush: jest.fn(),
  sendJobCompletedPush: jest.fn(),
  sendBookingStatusPush: jest.fn(),
  sendPushNotification: jest.fn(),
}));

// The slot reservation talks to Mongo transactions, which the in-memory test
// database (no replica set) doesn't offer. Everything before and after it is real.
const mockPrepare = jest.fn(async () => ({}));
const mockCommit = jest.fn(async () => ({
  lock: { _id: "lock-1" },
  requiredCount: 1,
  expiresAt: new Date(Date.now() + 10 * 60 * 1000),
}));
jest.mock("../services/slotCapacity.service", () => ({
  ...jest.requireActual("../services/slotCapacity.service"),
  prepareSlotReservation: (...args) => mockPrepare(...args),
  commitSlotReservation: (...args) => mockCommit(...args),
}));

const mongoose = require("mongoose");
const Address = require("../models/Address");
const Booking = require("../models/Booking");
const Category = require("../models/Category");
const Partner = require("../models/Partner");
const Service = require("../models/service.model");
const User = require("../models/User");
const Zone = require("../models/zone.model");
const { saveAddress, updateAddress, getAddresses } = require("../controllers/address.controller");
const { createBooking } = require("../controllers/booking.controller");
const { getPartnerBookings } = require("../controllers/partner.controller");
const { listHelperJobs } = require("../controllers/technicianHelper.controller");
const {
  parseReceiverContact,
  bookingReceiverFields,
  jobContact,
} = require("../utils/receiverContact");

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const call = async (handler, req) => {
  const res = mockRes();
  await handler(req, res);
  return res;
};

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

/* ---------- the rules ---------- */

describe("parseReceiverContact", () => {
  test("nothing sent is not an error — older app builds and the website don't send it", () => {
    for (const blank of [undefined, null, "", "   "]) {
      expect(parseReceiverContact(blank, blank)).toEqual({ provided: false });
    }
    expect(parseReceiverContact(undefined, "")).toEqual({ provided: false });
  });

  test("a good pair is tidied: the number to its 10 digits, the name to one clean line", () => {
    expect(parseReceiverContact("  Ravi   Kumar ", "+91 98765 43210")).toEqual({
      provided: true,
      name: "Ravi Kumar",
      phone: "9876543210",
    });
    expect(parseReceiverContact("Ravi", "098765-43210").phone).toBe("9876543210");
    expect(parseReceiverContact("Ravi\u0000\nKumar", "9876543210").name).toBe("Ravi Kumar");
    expect(parseReceiverContact("রবি কুমার", "9876543210").name).toBe("রবি কুমার");
  });

  test("a very long name is cut, not refused", () => {
    expect(parseReceiverContact("A".repeat(200), "9876543210").name).toHaveLength(60);
  });

  test("half a pair is refused", () => {
    expect(parseReceiverContact("Ravi", undefined).error).toMatch(/both the name and the phone/);
    expect(parseReceiverContact("Ravi", "  ").error).toMatch(/both the name and the phone/);
    expect(parseReceiverContact(undefined, "9876543210").error).toMatch(/both the name and the phone/);
    expect(parseReceiverContact("   ", "9876543210").error).toMatch(/both the name and the phone/);
  });

  test("a number that isn't a 10-digit mobile is refused", () => {
    for (const phone of ["12345", "98765432101234", "abcdefghij", ["9876543210"], { $ne: "" }]) {
      expect(parseReceiverContact("Ravi", phone).error).toMatch(/valid 10-digit mobile number/);
    }
  });

  test("a name that isn't text is refused", () => {
    expect(parseReceiverContact({ $ne: "" }, "9876543210").error).toBeTruthy();
    expect(parseReceiverContact(["Ravi"], "9876543210").error).toBeTruthy();
  });
});

describe("bookingReceiverFields", () => {
  const account = { name: "Asha Roy", phone: "9876500001" };
  const parsed = (name, phone) => parseReceiverContact(name, phone);

  test("booking for someone else records them", () => {
    expect(bookingReceiverFields(parsed("Ravi", "9876500002"), account)).toEqual({
      receiverName: "Ravi",
      receiverPhone: "9876500002",
    });
  });

  test("booking for yourself records nothing — the booking is exactly what it was before", () => {
    expect(bookingReceiverFields(parsed("Asha Roy", "9876500001"), account)).toEqual({
      receiverName: null,
      receiverPhone: null,
    });
    // however the same person's details are typed
    expect(bookingReceiverFields(parsed("  asha   roy ", "+91 98765 00001"), account)).toEqual({
      receiverName: null,
      receiverPhone: null,
    });
  });

  test("your own number under another name, or another number under your name, is someone else", () => {
    expect(bookingReceiverFields(parsed("Asha D", "9876500001"), account).receiverName).toBe("Asha D");
    expect(bookingReceiverFields(parsed("Asha Roy", "9876500002"), account).receiverPhone).toBe("9876500002");
  });

  test("nothing sent records nothing", () => {
    expect(bookingReceiverFields({ provided: false }, account)).toEqual({ receiverName: null, receiverPhone: null });
    expect(bookingReceiverFields(undefined, account)).toEqual({ receiverName: null, receiverPhone: null });
  });
});

describe("jobContact (who the professional is shown as 'the customer')", () => {
  const user = { name: "Asha", phone: "9876500001" };

  test("the person at the address when the booking names one", () => {
    expect(jobContact({ receiverName: "Ravi", receiverPhone: "9876500002" }, user)).toEqual({
      name: "Ravi",
      phone: "9876500002",
    });
  });

  test("otherwise the account holder, as it always was", () => {
    expect(jobContact({}, user)).toEqual({ name: "Asha", phone: "9876500001" });
    expect(jobContact({ receiverName: null, receiverPhone: null }, user)).toEqual({ name: "Asha", phone: "9876500001" });
    expect(jobContact(null, user)).toEqual({ name: "Asha", phone: "9876500001" });
  });

  test("half a receiver is never used — a name must not come with someone else's number", () => {
    expect(jobContact({ receiverName: "Ravi" }, user)).toEqual({ name: "Asha", phone: "9876500001" });
    expect(jobContact({ receiverPhone: "9876500002" }, user)).toEqual({ name: "Asha", phone: "9876500001" });
  });

  test("an account with no details still yields something to show", () => {
    expect(jobContact({}, undefined)).toEqual({ name: "Customer", phone: "" });
    expect(jobContact({}, {})).toEqual({ name: "Customer", phone: "" });
  });
});

/* ---------- saved addresses ---------- */

describe("saved addresses", () => {
  let user;
  beforeEach(async () => {
    user = await User.create({ name: "Asha", phone: "9876500001" });
  });

  const addressBody = (extra = {}) => ({
    label: "Home",
    address: "12 Park Street",
    pincode: "700016",
    latitude: 22.5526,
    longitude: 88.3525,
    houseDetails: "Flat 4B",
    ...extra,
  });
  const save = (body) => call(saveAddress, { user, body });
  const update = (id, body) => call(updateAddress, { user, params: { id: String(id) }, body });
  const stored = (id) => Address.findById(id).lean();

  test("remember who to ask for at an address, and give it back with the list", async () => {
    const res = await save(addressBody({ receiverName: "Ravi", receiverPhone: "+91 98765 00002" }));

    expect(res.statusCode).toBe(201);
    expect(res.body.address).toMatchObject({ receiverName: "Ravi", receiverPhone: "9876500002" });

    const list = await call(getAddresses, { user });
    expect(list.body.addresses[0]).toMatchObject({ receiverName: "Ravi", receiverPhone: "9876500002" });
  });

  test("an address saved without one has none", async () => {
    const res = await save(addressBody());

    expect(res.statusCode).toBe(201);
    expect(res.body.address.receiverName).toBeNull();
    expect(res.body.address.receiverPhone).toBeNull();
  });

  test("a Hotel address can be saved (the app offers it)", async () => {
    const res = await save(addressBody({ label: "Hotel" }));

    expect(res.statusCode).toBe(201);
    expect(res.body.address.label).toBe("Hotel");
  });

  test("saving the same place again updates it — the latest receiver wins, a request that doesn't mention one leaves it", async () => {
    const first = await save(addressBody({ receiverName: "Ravi", receiverPhone: "9876500002" }));
    const id = first.body.address._id;

    const again = await save(addressBody({ receiverName: "Meena", receiverPhone: "9876500003" }));
    expect(again.statusCode).toBe(200);
    expect(await Address.countDocuments({ user: user._id })).toBe(1);
    expect(await stored(id)).toMatchObject({ receiverName: "Meena", receiverPhone: "9876500003" });

    // the Home screen's quick save never mentions a receiver
    await save(addressBody({ label: "Work" }));
    expect(await stored(id)).toMatchObject({ label: "Work", receiverName: "Meena", receiverPhone: "9876500003" });

    // sending it blank clears it
    await save(addressBody({ receiverName: "", receiverPhone: "" }));
    expect(await stored(id)).toMatchObject({ receiverName: null, receiverPhone: null });
  });

  test("editing an address changes its receiver on the same terms", async () => {
    const created = await save(addressBody({ receiverName: "Ravi", receiverPhone: "9876500002" }));
    const id = created.body.address._id;

    const changed = await update(id, addressBody({ receiverName: "Meena", receiverPhone: "9876500003" }));
    expect(changed.statusCode).toBe(200);
    expect(changed.body.address).toMatchObject({ receiverName: "Meena", receiverPhone: "9876500003" });

    await update(id, addressBody({ houseDetails: "Flat 5C" }));
    expect(await stored(id)).toMatchObject({ houseDetails: "Flat 5C", receiverName: "Meena" });

    await update(id, addressBody({ receiverName: "", receiverPhone: "" }));
    expect(await stored(id)).toMatchObject({ receiverName: null, receiverPhone: null });
  });

  test("a receiver that isn't usable is refused, and nothing is saved or changed", async () => {
    const bad = await save(addressBody({ receiverName: "Ravi", receiverPhone: "12345" }));
    expect(bad.statusCode).toBe(400);
    expect(bad.body.message).toMatch(/valid 10-digit mobile number/);
    expect(await Address.countDocuments({})).toBe(0);

    const created = await save(addressBody({ receiverName: "Ravi", receiverPhone: "9876500002" }));
    const half = await update(created.body.address._id, addressBody({ receiverName: "Meena" }));
    expect(half.statusCode).toBe(400);
    expect(await stored(created.body.address._id)).toMatchObject({ receiverName: "Ravi" });
  });
});

/* ---------- what the professional sees ---------- */

describe("what the partner apps show as 'the customer'", () => {
  let user;
  let service;
  let tech;
  let helper;

  beforeEach(async () => {
    const category = await Category.create({ name: "AC Repair" });
    service = await Service.create({ name: "Split AC Service", price: 1000, category: category._id, isActive: true, commissionPercent: 20 });
    user = await User.create({ name: "Asha", phone: "9876500101" });
    const base = { password: "Secret123", approvalStatus: "APPROVED", serviceCategories: ["AC Repair"] };
    tech = await Partner.create({ ...base, name: "Ravi T", phone: "9876500001", skillTier: 2 });
    helper = await Partner.create({ ...base, name: "Amit", phone: "9876500002" });
  });

  const makeBooking = (extra = {}) =>
    Booking.create({
      user: user._id,
      services: [{ serviceId: service._id, name: service.name, quantity: 1, price: 1000, lineTotal: 1000 }],
      serviceId: service._id,
      serviceCategory: "AC Repair",
      baseAmount: 1000,
      discountAmount: 0,
      totalAmount: 1180,
      scheduledDate: new Date(),
      scheduledTime: "10:00 AM",
      location: { type: "Point", coordinates: [88.36, 22.57] },
      pincode: "700016",
      address: "12 Park Street",
      payment: { status: "PAID" },
      status: "PARTNER_ACCEPTED",
      partner: tech._id,
      ...extra,
    });

  const jobsFor = async (partner) => (await call(getPartnerBookings, { partner, query: {} })).body.bookings;
  const forSomeoneElse = { receiverName: "Ravi Kumar", receiverPhone: "9876500002" };

  test("the job card names the person at the address and gives their number", async () => {
    await makeBooking(forSomeoneElse);

    const [job] = await jobsFor(tech);

    expect(job.customerName).toBe("Ravi Kumar");
    expect(job.customerPhone).toBe("9876500002");
  });

  test("a booking for yourself shows the account holder, exactly as before", async () => {
    await makeBooking();

    const [job] = await jobsFor(tech);

    expect(job.customerName).toBe("Asha");
    expect(job.customerPhone).toBe("9876500101");
  });

  test("their number is withheld once the job is finished, like the account holder's", async () => {
    await makeBooking({ ...forSomeoneElse, status: "COMPLETED" });
    await makeBooking({ ...forSomeoneElse, status: "CANCELLED" });

    const jobs = await jobsFor(tech);

    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.customerPhone).toBe("");
      // the rest of the record stays for the partner's history
      expect(job.customerName).toBe("Ravi Kumar");
    }
  });

  test("a helper on the team sees the same person", async () => {
    await makeBooking({
      ...forSomeoneElse,
      additionalPartners: [helper._id],
      teamAllocations: [
        { partnerId: tech._id, payoutRatio: 0.6, isPrimary: true },
        { partnerId: helper._id, payoutRatio: 0.4, isPrimary: false },
      ],
    });

    const [job] = await jobsFor(helper);
    expect(job.customerName).toBe("Ravi Kumar");
    expect(job.customerPhone).toBe("9876500002");
  });

  test("the technician-helper job list shows them too, and withholds the number when completed", async () => {
    const live = await makeBooking({ ...forSomeoneElse, helpers: [{ partnerId: helper._id, name: "Amit", phone: "9876500002" }] });
    await Booking.updateOne({ _id: live._id }, { $set: { "helpers.0.partnerId": helper._id } });
    const done = await makeBooking({ ...forSomeoneElse, status: "COMPLETED", helpers: [{ partnerId: helper._id }] });
    const noReceiver = await makeBooking({ helpers: [{ partnerId: helper._id }] });

    const res = await call(listHelperJobs, { partner: helper });
    const byId = new Map(res.body.jobs.map((j) => [j.bookingId, j]));

    expect(byId.get(String(live._id))).toMatchObject({ customerName: "Ravi Kumar", customerPhone: "9876500002" });
    expect(byId.get(String(done._id))).toMatchObject({ customerName: "Ravi Kumar", customerPhone: "" });
    expect(byId.get(String(noReceiver._id))).toMatchObject({ customerName: "Asha", customerPhone: "9876500101" });
  });
});

describe("guest mehendi added on the spot", () => {
  test("rides the same visit: the same person is at the door", async () => {
    const { createGuestAddon } = require("../controllers/guestAddon.controller");
    const user = await User.create({ name: "Asha", phone: "9876500101" });
    const artist = await Partner.create({
      name: "Artist",
      phone: "9876500401",
      password: "Secret123",
      approvalStatus: "APPROVED",
    });
    await Service.create({ name: "Mehendi for Guests", price: 150, isActive: true });
    const parent = await Booking.create({
      user: user._id,
      partner: artist._id,
      status: "IN_PROGRESS",
      serviceCategory: "mehendi",
      services: [{ serviceId: new mongoose.Types.ObjectId(), name: "Bridal Mehendi", quantity: 1, price: 5000, lineTotal: 5000, category: "mehendi" }],
      baseAmount: 5000,
      totalAmount: 5900,
      scheduledDate: new Date(),
      scheduledTime: "10:00 AM",
      location: { type: "Point", coordinates: [88.36, 22.57] },
      pincode: "700016",
      address: "12 Park Street",
      payment: { status: "PAID" },
      receiverName: "Ravi Kumar",
      receiverPhone: "9876500002",
    });

    const res = await call(createGuestAddon, {
      partner: artist,
      body: { parentBookingId: String(parent._id), quantity: 2 },
    });

    expect(res.body).toMatchObject({ success: true });
    const addon = await Booking.findOne({ parentBooking: parent._id }).lean();
    expect(addon).toMatchObject({ receiverName: "Ravi Kumar", receiverPhone: "9876500002" });
  });
});

describe("the job offer the engine sends when it assigns a booking", () => {
  const PINCODE = "700091";
  let emitted;

  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    emitted = [];
    global.io = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) };
  });

  afterEach(() => {
    delete global.io;
  });

  const assignedPayload = async (receiver) => {
    const { assignBooking } = require("../services/assignmentEngine");
    const user = await User.create({ name: "Asha", phone: "9876500101" });
    const salon = await Category.create({ name: "Salon for Women", slug: "salon-for-women" });
    const facial = await Service.create({ name: "Hydration facial", price: 449, category: salon._id, duration: 45 });
    await Partner.create({
      name: "Beautician",
      phone: "9876500301",
      password: "hashed-irrelevant",
      approvalStatus: "APPROVED",
      gender: "FEMALE",
      serviceAreas: [PINCODE],
      services: [{ serviceId: facial._id, name: facial.name, isActive: true }],
    });
    const start = new Date();
    start.setDate(start.getDate() + 7);
    start.setHours(10, 0, 0, 0);
    const booking = await Booking.create({
      user: user._id,
      baseAmount: 1000,
      totalAmount: 1000,
      scheduledDate: start,
      scheduledTime: "10:00",
      scheduledStartAt: start,
      pincode: PINCODE,
      location: { type: "Point", coordinates: [88.43, 22.57] },
      status: "PENDING_ASSIGNMENT",
      serviceCategory: "Salon for Women",
      services: [{ serviceId: facial._id, name: facial.name, price: 499, lineTotal: 499, quantity: 1, category: "Salon for Women" }],
      ...receiver,
    });

    expect(await assignBooking(booking._id)).not.toBeNull();

    const offer = emitted.find((e) => e.event === "jobAssigned");
    expect(offer).toBeTruthy();
    return offer.payload;
  };

  test("names the person at the address, with their number", async () => {
    const payload = await assignedPayload({ receiverName: "Ravi Kumar", receiverPhone: "9876500002" });

    expect(payload.customerName).toBe("Ravi Kumar");
    expect(payload.customerPhone).toBe("9876500002");
  });

  test("names the account holder when the booking names no one else", async () => {
    const payload = await assignedPayload({});

    expect(payload.customerName).toBe("Asha");
    expect(payload.customerPhone).toBe("9876500101");
  });
});

/* ---------- creating a booking ---------- */

describe("creating a booking", () => {
  let user;
  let service;

  beforeEach(async () => {
    mockPrepare.mockClear();
    mockCommit.mockClear();
    const category = await Category.create({ name: "Salon for Women" });
    service = await Service.create({ name: "Facial", price: 500, category: category._id, isActive: true });
    await Zone.create({ pincode: "700016" });
    user = await User.create({ name: "Asha Roy", phone: "9876500001" });
  });

  const tomorrow = () => {
    const d = new Date(Date.now() + 36 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  const bookingBody = (extra = {}) => ({
    services: [{ serviceId: String(service._id), quantity: 1 }],
    serviceCategory: "Salon for Women",
    scheduledDate: tomorrow(),
    scheduledTime: "10:00 AM",
    pincode: "700016",
    address: "12 Park Street",
    houseDetails: "Flat 4B",
    location: { type: "Point", coordinates: [88.3525, 22.5526] },
    ...extra,
  });

  // The slot reservation and the transaction around it are replaced (see the
  // mocks above); the booking the controller builds is captured as it is inserted.
  let inserted;
  beforeEach(() => {
    inserted = null;
    jest.spyOn(mongoose, "startSession").mockResolvedValue({
      withTransaction: async (fn) => fn(),
      endSession: async () => {},
    });
    jest.spyOn(Booking, "create").mockImplementation(async ([payload]) => {
      inserted = payload;
      return [{ ...payload, _id: new mongoose.Types.ObjectId() }];
    });
  });

  const create = (body) => call(createBooking, { user, body });

  test("booking for someone else saves who will be at the door", async () => {
    const res = await create(bookingBody({ receiverName: "  Ravi   Kumar ", receiverPhone: "+91 98765 00002" }));

    expect(res.statusCode).toBe(201);
    expect(inserted).toMatchObject({ receiverName: "Ravi Kumar", receiverPhone: "9876500002", houseDetails: "Flat 4B" });
  });

  test("booking for yourself — or sending nothing — saves no receiver", async () => {
    const asMyself = await create(bookingBody({ receiverName: "Asha Roy", receiverPhone: "9876500001" }));
    expect(asMyself.statusCode).toBe(201);
    expect(inserted).toMatchObject({ receiverName: null, receiverPhone: null });

    const nothing = await create(bookingBody());
    expect(nothing.statusCode).toBe(201);
    expect(inserted).toMatchObject({ receiverName: null, receiverPhone: null });
  });

  test("a receiver that isn't usable is refused before a slot is held", async () => {
    const badNumber = await create(bookingBody({ receiverName: "Ravi", receiverPhone: "12345" }));
    expect(badNumber.statusCode).toBe(400);
    expect(badNumber.body.message).toMatch(/valid 10-digit mobile number/);

    const half = await create(bookingBody({ receiverName: "Ravi" }));
    expect(half.statusCode).toBe(400);
    expect(half.body.message).toMatch(/both the name and the phone/);

    expect(mockPrepare).not.toHaveBeenCalled();
    expect(inserted).toBeNull();
  });
});
