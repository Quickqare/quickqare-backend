// Canonical phone handling — the single source of truth for turning a
// client-supplied phone into a DB key, a rate-limit bucket, or an MSG91
// destination, so all three always agree on which real number a request is about.
//
// Why: MSG91 has always normalised numbers (strip non-digits, add the country
// code), but DB lookups and the per-phone rate limiters used the raw request
// string. "9876543210", "919876543210" and "98765-43210" were ONE phone to MSG91
// but separate accounts and separate rate-limit buckets — reformatting a
// victim's number dodged the per-number OTP cap (SMS bombing / MSG91 bill abuse),
// and one real phone could hold several accounts (e.g. to escape an admin block).

const NATIONAL_NUMBER_LENGTH = 10;

const getCountryCode = () =>
  String(process.env.MSG91_COUNTRY_CODE || "91").replace(/\D/g, "") || "91";

// Canonical stored form: the 10-digit national number ("9876543210") — what
// every client already sends. Accepts the formats people actually type
// ("+91 98765 43210", "919876543210", "098765 43210", "98765-43210") and returns
// "" for anything that doesn't reduce to exactly one 10-digit number, including
// non-string input (an array would otherwise stringify to a valid number).
function toNationalPhone(phone) {
  if (typeof phone !== "string" && typeof phone !== "number") return "";

  // Leading zeros are dialling prefixes (trunk "0", international "00"),
  // never part of a national number.
  let digits = String(phone).replace(/\D/g, "").replace(/^0+/, "");
  const countryCode = getCountryCode();
  if (digits.length > NATIONAL_NUMBER_LENGTH && digits.startsWith(countryCode)) {
    digits = digits.slice(countryCode.length);
  }
  return digits.length === NATIONAL_NUMBER_LENGTH ? digits : "";
}

// MSG91 destination form: country code + national number ("919876543210").
function toInternationalPhone(phone) {
  const national = toNationalPhone(phone);
  return national ? `${getCountryCode()}${national}` : "";
}

const INVALID_PHONE_MESSAGE = "Enter a valid 10-digit mobile number";

module.exports = {
  NATIONAL_NUMBER_LENGTH,
  INVALID_PHONE_MESSAGE,
  getCountryCode,
  toNationalPhone,
  toInternationalPhone,
};
