const normalizePhone = (phone = "") =>
  String(phone).replace(/\D/g, "");

const getCountryCode = () =>
  String(process.env.MSG91_COUNTRY_CODE || "91").replace(/\D/g, "") || "91";

const toInternationalPhone = (phone) => {
  const normalized = normalizePhone(phone);
  const countryCode = getCountryCode();

  if (!normalized) return "";
  if (normalized.startsWith(countryCode) && normalized.length > 10) {
    return normalized;
  }

  return `${countryCode}${normalized}`;
};

const getRequiredConfig = () => {
  const authKey = String(process.env.MSG91_AUTH_KEY || "").trim();
  const templateId = String(process.env.MSG91_TEMPLATE_ID || "").trim();

  if (!authKey) {
    const error = new Error("MSG91 configuration missing");
    error.statusCode = 500;
    throw error;
  }

  return { authKey, templateId };
};

async function sendOtp(phone) {
  const { authKey, templateId } = getRequiredConfig();
  const mobile = toInternationalPhone(phone);

  if (!templateId) {
    const error = new Error("MSG91_TEMPLATE_ID is missing");
    error.statusCode = 500;
    throw error;
  }

  if (!mobile) {
    const error = new Error("Valid phone number required");
    error.statusCode = 400;
    throw error;
  }

  const url = `https://control.msg91.com/api/v5/otp?template_id=${encodeURIComponent(
    templateId
  )}&mobile=${encodeURIComponent(mobile)}&authkey=${encodeURIComponent(authKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data?.type === "error") {
    const error = new Error(
      data?.message ||
        data?.error ||
        `MSG91 failed to send OTP (HTTP ${response.status || "unknown"})`
    );
    error.statusCode = response.status || 502;
    throw error;
  }

  return {
    success: true,
    data,
  };
}

async function verifyOtp(phone, otp) {
  const { authKey } = getRequiredConfig();
  const mobile = toInternationalPhone(phone);
  const code = String(otp || "").trim();

  if (!mobile || !code) {
    const error = new Error("Phone number and OTP are required");
    error.statusCode = 400;
    throw error;
  }

  const url = `https://control.msg91.com/api/v5/otp/verify?mobile=${encodeURIComponent(
    mobile
  )}&otp=${encodeURIComponent(code)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      authkey: authKey,
    },
  });

  const data = await response.json().catch(() => ({}));
  const message = String(data?.message || "").toLowerCase();
  const isSuccess =
    response.ok &&
    (data?.type === "success" ||
      message.includes("verified") ||
      message.includes("success"));

  if (!isSuccess) {
    const error = new Error(data?.message || "Invalid OTP");
    error.statusCode = response.status === 200 ? 400 : response.status || 400;
    throw error;
  }

  return {
    success: true,
    data,
  };
}

const getMessage = (data = {}) =>
  String(
    data?.message ||
      data?.msg ||
      data?.error ||
      data?.description ||
      ""
  ).toLowerCase();

const isAccessTokenVerified = (data = {}) => {
  const message = getMessage(data);

  return Boolean(
    data?.type === "success" ||
      data?.success === true ||
      data?.verified === true ||
      data?.status === true ||
      data?.status === "success" ||
      data?.result === "success" ||
      message.includes("verified") ||
      message.includes("success")
  );
};

// ── Phone binding ─────────────────────────────────────────────────────────────
// The MSG91 access token certifies that *some* phone completed OTP. To stop a
// caller from claiming a different number, we recover the phone MSG91 actually
// verified — from the verifyAccessToken response and/or the access token's own
// JWT payload — and let the caller compare it to the submitted phone.
//
// We don't assume a field name: we collect every phone-shaped value we can find.
// A legitimate login's submitted number WILL appear; an attacker reusing their
// own token to claim a victim's number will NOT match.

// Decode a JWT payload without verifying its signature (we only verify the token
// via MSG91's API; here we just want to read the claims). Returns {} on failure.
const decodeJwtPayload = (token) => {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return {};
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json) || {};
  } catch {
    return {};
  }
};

// Keys that hold a phone number across MSG91 responses / widget tokens. MSG91's
// own widget uses `identifier` for the mobile, so that's the most likely one.
const PHONE_KEY_RE = /(phone|mobile|msisdn|identifier|^number$|contact|^to$)/i;

// MSG91 also returns bare payloads in `message` rather than a named field — the
// web client's own parser relies on exactly this, pulling both the reqId and the
// access token out of `message`. So a `message` whose entire value is a phone
// number counts as a candidate too. A human-readable message ("OTP verified
// successfully") does not, because it isn't phone-shaped.
const LOOSE_PHONE_KEY_RE = /^(message|msg)$/i;

const isPhoneShaped = (digits) => digits.length >= 10 && digits.length <= 15;

// True only when the value is *nothing but* a phone number, allowing the "+",
// spaces and dashes MSG91 sometimes formats with. Guards the loose `message`
// path from swallowing prose that merely contains digits.
const isBarePhoneString = (value) => {
  const raw = String(value).trim();
  if (!/^\+?[\d\s-]+$/.test(raw)) return false;
  return isPhoneShaped(raw.replace(/\D/g, ""));
};

// Walk any JSON value and collect digit-strings that look like phone numbers.
// A value counts when it sits under a phone-named key (at any depth), or when it
// is a bare phone number under `message`. This deliberately ignores numeric JWT
// claims like `exp`/`iat` (10-digit unix timestamps) and random numeric IDs,
// which would otherwise masquerade as phones and cause false mismatches.
//
// `keyKind` is "phone" inside a phone-named subtree, "loose" for the immediate
// value of a `message` key, and null otherwise.
const collectPhoneCandidates = (value, out = new Set(), keyKind = null) => {
  if (value == null) return out;
  if (typeof value === "string" || typeof value === "number") {
    const digits = String(value).replace(/\D/g, "");
    if (keyKind === "phone" && isPhoneShaped(digits)) out.add(digits);
    else if (keyKind === "loose" && isBarePhoneString(value)) out.add(digits);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPhoneCandidates(item, out, keyKind);
    return out;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value)) {
      // Once inside a phone-named key, every descendant stays "phone". "loose"
      // never propagates — it only ever applies to the scalar at `message`.
      const childKind = PHONE_KEY_RE.test(key)
        ? "phone"
        : LOOSE_PHONE_KEY_RE.test(key)
        ? "loose"
        : keyKind === "phone"
        ? "phone"
        : null;
      collectPhoneCandidates(value[key], out, childKind);
    }
  }
  return out;
};

// Returns an array of normalised phone candidates (digits only) recovered from
// the verified token + MSG91 response. Empty array = nothing could be recovered.
const extractVerifiedPhones = (accessToken, responseData) => {
  const candidates = new Set();
  collectPhoneCandidates(responseData, candidates);
  collectPhoneCandidates(decodeJwtPayload(accessToken), candidates);
  return [...candidates];
};

// True iff `phone` matches one of the verified candidates. Compares on the last
// 10 digits so country-code formatting differences don't cause false mismatches.
const phoneMatchesVerified = (verifiedPhones, phone) => {
  if (!Array.isArray(verifiedPhones) || verifiedPhones.length === 0) return false;
  const submitted = toInternationalPhone(phone).replace(/\D/g, "");
  const submitted10 = submitted.slice(-10);
  if (!submitted10) return false;
  return verifiedPhones.some((p) => {
    const d = String(p).replace(/\D/g, "");
    return d === submitted || d.slice(-10) === submitted10;
  });
};

async function verifyAccessToken(accessToken) {
  const { authKey } = getRequiredConfig();
  const token = String(accessToken || "").trim();

  if (!token) {
    const error = new Error("MSG91 access token is required");
    error.statusCode = 400;
    throw error;
  }

  const response = await fetch(
    "https://control.msg91.com/api/v5/widget/verifyAccessToken",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        authkey: authKey,
        authKey,
        "access-token": token,
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !isAccessTokenVerified(data)) {
    const error = new Error(
      data?.message || data?.error || "MSG91 access token verification failed"
    );
    error.statusCode = response.status || 400;
    throw error;
  }

  return {
    success: true,
    data,
    // Phone(s) MSG91 actually verified for this token — used to bind the issued
    // session to the right number. May be empty if MSG91 doesn't echo the phone.
    verifiedPhones: extractVerifiedPhones(token, data),
  };
}

module.exports = {
  sendOtp,
  verifyOtp,
  verifyAccessToken,
  toInternationalPhone,
  phoneMatchesVerified,
  extractVerifiedPhones,
};
