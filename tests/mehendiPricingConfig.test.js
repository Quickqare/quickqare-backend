/**
 * The mehendi hand-package prices the customer app shows (customer-app audit,
 * Oct 2026, item 13). The app used to carry its own copy of the tier tables, so an
 * admin changing a price (AdminSetting.mehendiHandsPricing) changed what the
 * server charged but not what the customer saw. GET /api/app-config now publishes
 * the tables in force, and they must be exactly the ones the charge uses.
 */
const AdminSetting = require("../admin/models/AdminSetting");
const appConfigRoutes = require("../routes/appConfig.routes");

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

const getAppConfig = async () => {
  const layer = appConfigRoutes.stack.find((l) => l.route && l.route.path === "/" && l.route.methods.get);
  const res = mockRes();
  await layer.route.stack[layer.route.stack.length - 1].handle({}, res);
  return res.body;
};

// pricing.js keeps the admin override in a 60 s module cache; a fresh copy per
// test keeps one test's override from leaking into the next.
const freshPricing = () => {
  let pricing;
  jest.isolateModules(() => {
    pricing = require("../utils/pricing");
  });
  return pricing;
};

// The price the app computes from a published table: the rule the app mirrors.
const priceFromPublishedTable = (table, hands) => {
  const quantity = Math.max(Number(hands) || 1, 1);
  const tier = Number(table.tierPrices[quantity - 1]);
  if (Number.isFinite(tier) && tier > 0) return tier;
  if (!(table.overflowPerHand > 0)) return null;
  return Math.round(quantity * table.overflowPerHand);
};

const RULES = [
  "mehendi_minimal_hands",
  "mehendi_palm_length_hands",
  "mehendi_bangle_length_hands",
  "mehendi_mid_length_hands",
  "mehendi_elbow_bridal_hands",
  "mehendi_above_elbow_bridal_hands",
];

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("resolveEffectiveMehendiHandsPricing", () => {
  test("with no override it is the code defaults, for every rule, as plain numbers", () => {
    const { resolveEffectiveMehendiHandsPricing, DEFAULT_MEHENDI_HANDS_PRICING } = freshPricing();

    const tables = resolveEffectiveMehendiHandsPricing(null);

    expect(Object.keys(tables).sort()).toEqual([...RULES].sort());
    for (const rule of RULES) {
      expect(tables[rule]).toEqual({
        tierPrices: DEFAULT_MEHENDI_HANDS_PRICING[rule].tierPrices,
        overflowPerHand: DEFAULT_MEHENDI_HANDS_PRICING[rule].overflowPerHand,
      });
    }
  });

  test("an admin override replaces that rule only", () => {
    const { resolveEffectiveMehendiHandsPricing, DEFAULT_MEHENDI_HANDS_PRICING } = freshPricing();

    const tables = resolveEffectiveMehendiHandsPricing({
      mehendi_minimal_hands: { tierPrices: [449, 749, 1049], overflowPerHand: 320 },
    });

    expect(tables.mehendi_minimal_hands).toEqual({ tierPrices: [449, 749, 1049], overflowPerHand: 320 });
    expect(tables.mehendi_palm_length_hands.tierPrices).toEqual(DEFAULT_MEHENDI_HANDS_PRICING.mehendi_palm_length_hands.tierPrices);
  });

  test("a blank or half-filled override can't zero out a price: the default stays in force", () => {
    const { resolveEffectiveMehendiHandsPricing, DEFAULT_MEHENDI_HANDS_PRICING } = freshPricing();

    const tables = resolveEffectiveMehendiHandsPricing({
      mehendi_minimal_hands: { tierPrices: [], overflowPerHand: 0 },
      mehendi_palm_length_hands: { tierPrices: [0, 0], overflowPerHand: 100 },
      mehendi_mid_length_hands: { overflowPerHand: 500 },
      mehendi_elbow_bridal_hands: "garbage",
    });

    for (const rule of ["mehendi_minimal_hands", "mehendi_palm_length_hands", "mehendi_mid_length_hands", "mehendi_elbow_bridal_hands"]) {
      expect(tables[rule].tierPrices).toEqual(DEFAULT_MEHENDI_HANDS_PRICING[rule].tierPrices);
      expect(tables[rule].overflowPerHand).toBe(DEFAULT_MEHENDI_HANDS_PRICING[rule].overflowPerHand);
    }
  });

  test("an override with prices but no per-hand rate publishes none, as the charge has none", () => {
    const { resolveEffectiveMehendiHandsPricing } = freshPricing();

    const tables = resolveEffectiveMehendiHandsPricing({ mehendi_minimal_hands: { tierPrices: [449, 749] } });

    expect(tables.mehendi_minimal_hands).toEqual({ tierPrices: [449, 749], overflowPerHand: 0 });
  });
});

describe("GET /api/app-config", () => {
  test("publishes the tables in force: the defaults when the admin hasn't changed anything", async () => {
    const config = await getAppConfig();

    expect(config.success).toBe(true);
    expect(Object.keys(config.mehendiHandsPricing).sort()).toEqual([...RULES].sort());
    expect(config.mehendiHandsPricing.mehendi_minimal_hands.tierPrices).toEqual([399, 699, 999, 1199]);
  });

  test("publishes the admin's override", async () => {
    await AdminSetting.create({
      mehendiHandsPricing: { mehendi_minimal_hands: { tierPrices: [449, 749, 1049, 1299], overflowPerHand: 329 } },
    });

    const config = await getAppConfig();

    expect(config.mehendiHandsPricing.mehendi_minimal_hands).toEqual({
      tierPrices: [449, 749, 1049, 1299],
      overflowPerHand: 329,
    });
  });
});

describe("what the app is shown is what the server charges", () => {
  const compareEveryHandCount = async () => {
    const config = await getAppConfig();
    const pricing = freshPricing();
    for (const rule of RULES) {
      for (let hands = 1; hands <= 15; hands += 1) {
        const charged = await pricing.getMehendiHandsPriceWithSettings(rule, hands);
        expect({ rule, hands, shown: priceFromPublishedTable(config.mehendiHandsPricing[rule], hands) }).toEqual({
          rule,
          hands,
          shown: charged,
        });
      }
    }
  };

  test("with the defaults", async () => {
    await compareEveryHandCount();
  });

  test("with an admin override on some rules, usable or not", async () => {
    await AdminSetting.create({
      mehendiHandsPricing: {
        mehendi_minimal_hands: { tierPrices: [449, 749, 1049, 1299], overflowPerHand: 329 },
        mehendi_bangle_length_hands: { tierPrices: [850, 0, 1750], overflowPerHand: 600 },
        mehendi_elbow_bridal_hands: { tierPrices: [], overflowPerHand: 0 },
      },
    });

    await compareEveryHandCount();
  });

  test("including an override that has tier prices but no per-hand rate", async () => {
    // Mongoose fills in a rule's missing fields from the schema defaults, so write
    // the raw document to get a genuinely partial override.
    await AdminSetting.collection.insertOne({
      mehendiHandsPricing: { mehendi_minimal_hands: { tierPrices: [449, 749] } },
    });

    await compareEveryHandCount();
  });
});
