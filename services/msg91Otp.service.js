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
    const error = new Error(data?.message || "MSG91 failed to send OTP");
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
  };
}

module.exports = {
  sendOtp,
  verifyOtp,
  verifyAccessToken,
  toInternationalPhone,
};
