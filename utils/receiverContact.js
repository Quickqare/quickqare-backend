const { toNationalPhone } = require("./phone");

// "Who will receive the service?" — the person the professional should ask for and
// call at the door. Usually the customer; when they book for someone else (a
// parent's flat, a gift) that someone. The customer app collects a name and a
// phone number together, and they travel as a pair: saved on an address, copied
// onto the booking, shown to the professional as "the customer".

const MAX_NAME_LENGTH = 60;

const isBlank = (value) =>
  value === undefined || value === null || (typeof value === "string" && !value.trim());

const cleanName = (value) =>
  typeof value === "string"
    ? value.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH)
    : "";

/**
 * Reads the receiver out of a request.
 *   { provided: false }               neither was sent (older app builds, the website)
 *   { provided: true, name, phone }   both usable; phone is the 10-digit national number
 *   { error }                         half a pair, or not a 10-digit mobile number
 */
function parseReceiverContact(rawName, rawPhone) {
  if (isBlank(rawName) && isBlank(rawPhone)) return { provided: false };

  const name = cleanName(rawName);
  if (!name || isBlank(rawPhone)) {
    return {
      error: "Please give both the name and the phone number of the person receiving the service.",
    };
  }

  const phone = toNationalPhone(rawPhone);
  if (!phone) {
    return { error: "Enter a valid 10-digit mobile number for the person receiving the service." };
  }

  return { provided: true, name, phone };
}

/**
 * What a booking stores. The account holder's own name and number add nothing —
 * the professional is given those anyway — so booking for yourself leaves the
 * booking exactly as it was before receivers existed, and only a different person
 * is recorded.
 */
function bookingReceiverFields(receiver, account) {
  const none = { receiverName: null, receiverPhone: null };
  if (!receiver?.provided) return none;

  const sameName = receiver.name.toLowerCase() === String(account?.name || "").trim().toLowerCase();
  const samePhone = receiver.phone === toNationalPhone(account?.phone);
  if (sameName && samePhone) return none;

  return { receiverName: receiver.name, receiverPhone: receiver.phone };
}

/**
 * Who the professional is shown as "the customer": the person at the address when
 * the booking names one, otherwise the account holder. Used by every payload the
 * partner apps read, so the partner app needs no change to ask for the right person.
 */
function jobContact(booking, user) {
  if (booking?.receiverName && booking?.receiverPhone) {
    return { name: booking.receiverName, phone: booking.receiverPhone };
  }
  return { name: user?.name || "Customer", phone: user?.phone || "" };
}

module.exports = {
  MAX_NAME_LENGTH,
  parseReceiverContact,
  bookingReceiverFields,
  jobContact,
};
