/**
 * A device's push token belongs to one customer account at a time
 * (customer-app audit, Oct 2026, item 14). Logging out used to leave it on the
 * account, so the phone kept receiving that customer's booking pushes — also
 * after someone else had signed in on it.
 */
const User = require("../models/User");
const { updateFcmToken, removeFcmToken } = require("../controllers/user.controller");
const userRoutes = require("../routes/user.routes");

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

const call = async (handler, user, body) => {
  const res = mockRes();
  await handler({ user: { id: user._id }, body }, res);
  return res;
};

let seq = 0;
const makeUser = (overrides = {}) => {
  seq += 1;
  return User.create({ name: `Customer ${seq}`, phone: `98760${String(seq).padStart(5, "0")}`, ...overrides });
};

const tokenOf = async (user) => (await User.findById(user._id).lean()).fcmToken;

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("registering a device token", () => {
  test("stores it on the account", async () => {
    const user = await makeUser();

    const res = await call(updateFcmToken, user, { fcmToken: "  phone-token  " });

    expect(res.statusCode).toBe(200);
    expect(await tokenOf(user)).toBe("phone-token");
  });

  test("takes it away from whoever was signed in on this phone before", async () => {
    const before = await makeUser({ fcmToken: "shared-phone" });
    const now = await makeUser();
    const bystander = await makeUser({ fcmToken: "someone-elses-phone" });

    await call(updateFcmToken, now, { fcmToken: "shared-phone" });

    expect(await tokenOf(now)).toBe("shared-phone");
    expect(await tokenOf(before)).toBe("");
    // A different phone is untouched.
    expect(await tokenOf(bystander)).toBe("someone-elses-phone");
  });

  test("re-registering the same token for the same account changes nothing", async () => {
    const user = await makeUser({ fcmToken: "phone-token" });

    const res = await call(updateFcmToken, user, { fcmToken: "phone-token" });

    expect(res.statusCode).toBe(200);
    expect(await tokenOf(user)).toBe("phone-token");
  });

  test("rejects a missing, empty or non-string token", async () => {
    const user = await makeUser({ fcmToken: "kept" });

    for (const body of [{}, { fcmToken: "" }, { fcmToken: "   " }, { fcmToken: { $ne: "" } }, { fcmToken: 42 }]) {
      const res = await call(updateFcmToken, user, body);
      expect(res.statusCode).toBe(400);
    }
    expect(await tokenOf(user)).toBe("kept");
  });
});

describe("removing a device token (logout)", () => {
  test("clears it when it is still the one on file", async () => {
    const user = await makeUser({ fcmToken: "phone-token" });

    const res = await call(removeFcmToken, user, { fcmToken: "phone-token" });

    expect(res.statusCode).toBe(200);
    expect(await tokenOf(user)).toBe("");
  });

  test("leaves another phone's token alone", async () => {
    // Logged out of the old phone after signing in on a new one.
    const user = await makeUser({ fcmToken: "new-phone" });

    const res = await call(removeFcmToken, user, { fcmToken: "old-phone" });

    expect(res.statusCode).toBe(200);
    expect(await tokenOf(user)).toBe("new-phone");
  });

  test("can't clear anyone else's token", async () => {
    const victim = await makeUser({ fcmToken: "victim-phone" });
    const attacker = await makeUser();

    await call(removeFcmToken, attacker, { fcmToken: "victim-phone" });

    expect(await tokenOf(victim)).toBe("victim-phone");
  });

  test("needs a token to remove", async () => {
    const user = await makeUser({ fcmToken: "phone-token" });

    for (const body of [undefined, {}, { fcmToken: "" }, { fcmToken: { $ne: null } }]) {
      const res = await call(removeFcmToken, user, body);
      expect(res.statusCode).toBe(400);
    }
    expect(await tokenOf(user)).toBe("phone-token");
  });
});

test("the removal is mounted as an authenticated DELETE /fcm-token", () => {
  const layer = userRoutes.stack.find((l) => l.route && l.route.path === "/fcm-token");

  expect(layer).toBeTruthy();
  expect(layer.route.methods.delete).toBe(true);
  // userAuth runs first, then the handler.
  expect(layer.route.stack.length).toBe(2);
});
