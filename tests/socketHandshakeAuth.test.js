/**
 * Socket handshake auth — the gate for all realtime updates.
 *
 * joinUserRoom / joinPartnerRoom silently ignore sockets without a verified
 * id, so a misclassified token means a client never receives booking_update /
 * job events. This bit us before: user tokens are signed { id, role: "user" }
 * but the middleware only recognised legacy { userId } / { sub } shapes, so no
 * customer socket was ever verified.
 */
const jwt = require("jsonwebtoken");

const { handshakeAuth } = require("../socket/handshakeAuth");
const { USER_TOKEN_COOKIE } = require("../utils/authCookie");

const USER_SECRET = "test_user_secret";

function makeSocket({ auth, cookie } = {}) {
  return {
    handshake: {
      auth: auth || {},
      headers: cookie ? { cookie } : {},
    },
  };
}

function run(socket) {
  let called = false;
  handshakeAuth(socket, () => { called = true; });
  expect(called).toBe(true); // middleware must never block the connection
  return socket;
}

describe("socket handshakeAuth", () => {
  // process.env is shared across suites under --runInBand — restore what we touch.
  const savedEnv = {};

  beforeAll(() => {
    savedEnv.JWT_SECRET = process.env.JWT_SECRET;
    savedEnv.PARTNER_JWT_SECRET = process.env.PARTNER_JWT_SECRET;
    process.env.JWT_SECRET = USER_SECRET;
    delete process.env.PARTNER_JWT_SECRET; // both roles share JWT_SECRET, like prod
  });

  afterAll(() => {
    if (savedEnv.JWT_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedEnv.JWT_SECRET;
    if (savedEnv.PARTNER_JWT_SECRET === undefined) delete process.env.PARTNER_JWT_SECRET;
    else process.env.PARTNER_JWT_SECRET = savedEnv.PARTNER_JWT_SECRET;
  });

  test("user token in handshake auth (mobile) → verifiedUserId", () => {
    const token = jwt.sign({ id: "user123", role: "user" }, USER_SECRET);
    const socket = run(makeSocket({ auth: { token } }));
    expect(socket.verifiedUserId).toBe("user123");
    expect(socket.verifiedPartnerId).toBeUndefined();
  });

  test("user token in httpOnly cookie (web) → verifiedUserId", () => {
    const token = jwt.sign({ id: "user456", role: "user" }, USER_SECRET);
    const socket = run(makeSocket({ cookie: `${USER_TOKEN_COOKIE}=${token}` }));
    expect(socket.verifiedUserId).toBe("user456");
  });

  test("partner token → verifiedPartnerId, not verifiedUserId", () => {
    const token = jwt.sign({ id: "partner789", role: "partner" }, USER_SECRET);
    const socket = run(makeSocket({ auth: { token } }));
    expect(socket.verifiedPartnerId).toBe("partner789");
    expect(socket.verifiedUserId).toBeUndefined();
  });

  test("legacy { userId } token still verifies", () => {
    const token = jwt.sign({ userId: "legacy1" }, USER_SECRET);
    const socket = run(makeSocket({ auth: { token } }));
    expect(socket.verifiedUserId).toBe("legacy1");
  });

  test("no token → connects unverified", () => {
    const socket = run(makeSocket());
    expect(socket.verifiedUserId).toBeUndefined();
    expect(socket.verifiedPartnerId).toBeUndefined();
  });

  test("garbage / wrongly-signed token → connects unverified", () => {
    const forged = jwt.sign({ id: "evil", role: "user" }, "wrong_secret");
    for (const token of ["not-a-jwt", forged]) {
      const socket = run(makeSocket({ auth: { token } }));
      expect(socket.verifiedUserId).toBeUndefined();
      expect(socket.verifiedPartnerId).toBeUndefined();
    }
  });
});
