/* =====================================================
   FIELD-LEVEL ENCRYPTION (encryption at rest)
   =====================================================
   AES-256-GCM authenticated encryption for individual sensitive DB fields
   (partner bank account numbers, IFSC). Anyone with raw DB / backup access
   sees ciphertext, not the plaintext account number.

   Key: FIELD_ENCRYPTION_KEY (env). Any non-empty string is accepted; the
   32-byte AES key is derived as sha256(FIELD_ENCRYPTION_KEY), so a passphrase
   or a hex string both work. Keep this key OUT of the DB and rotate via
   re-encryption if it leaks.

   Design notes:
   - Backward compatible: decryptField() returns legacy plaintext rows
     unchanged (they lack the "enc:v1:" marker), so switching this on does not
     require a data migration — existing rows decrypt to themselves and get
     encrypted the next time they're written.
   - Idempotent: encryptField() is a no-op on an already-encrypted value, so a
     snapshot copied from an already-encrypted source (Partner → Withdrawal)
     is never double-encrypted.
   - Fail-safe for dev/CI: if no key is configured, both functions pass the
     value through unchanged and log a one-time warning. At-rest encryption is
     simply OFF until the key is set — nothing breaks.
========================================================= */

const crypto = require("crypto");

const PREFIX = "enc:v1:";

let warned = false;
function getKey() {
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (!raw) {
    if (!warned) {
      warned = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[field-crypto] FIELD_ENCRYPTION_KEY not set — sensitive fields (bank " +
          "details) are stored in PLAINTEXT. Set it in production."
      );
    }
    return null;
  }
  // Derive a fixed 32-byte key from whatever passphrase/hex was supplied.
  return crypto.createHash("sha256").update(String(raw)).digest();
}

function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function encryptField(plain) {
  // Leave empty / non-string / already-encrypted values untouched.
  if (plain === null || plain === undefined || plain === "") return plain;
  const text = String(plain);
  if (isEncrypted(text)) return text;

  const key = getKey();
  if (!key) return text; // no key → store plaintext (dev/CI)

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

function decryptField(value) {
  if (!isEncrypted(value)) return value; // legacy plaintext or empty → as-is

  const key = getKey();
  if (!key) return value; // can't decrypt without the key; return marker as-is

  try {
    // Strip the "enc:v1:" marker first, then split the "<iv>:<tag>:<ct>" body.
    // (Splitting the whole string would misalign because the marker itself
    // contains a colon.)
    const [ivB64, tagB64, ctB64] = value.slice(PREFIX.length).split(":");
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const ciphertext = Buffer.from(ctB64, "base64");

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (err) {
    // Wrong key or tampered data — never throw into a request path (would leak
    // 500s / lose data). Log and return the raw value.
    // eslint-disable-next-line no-console
    console.error("[field-crypto] decrypt failed:", err.message);
    return value;
  }
}

/* ---- Bank-detail helpers -------------------------------------------------
   accountNumber + ifsc are encrypted; accountHolderName + bankName stay
   plaintext (needed for display/search and not independently sensitive).
   Works on both Mongoose subdocuments and plain/lean objects.
------------------------------------------------------------------------- */
function encryptBankDetails(bd) {
  if (!bd || typeof bd !== "object") return bd;
  return {
    accountHolderName: bd.accountHolderName || "",
    accountNumber: encryptField(bd.accountNumber),
    ifsc: encryptField(bd.ifsc),
    bankName: bd.bankName || "",
  };
}

function decryptBankDetails(bd) {
  if (!bd || typeof bd !== "object") return bd;
  return {
    accountHolderName: bd.accountHolderName || "",
    accountNumber: decryptField(bd.accountNumber),
    ifsc: decryptField(bd.ifsc),
    bankName: bd.bankName || "",
  };
}

// Last-4 mask for surfaces that only need to confirm which account, not the
// full number (e.g. the partner's own "your saved account" line).
function maskAccountNumber(value) {
  const plain = String(decryptField(value) || "");
  if (plain.length <= 4) return plain ? "••••" : "";
  return `••••${plain.slice(-4)}`;
}

module.exports = {
  encryptField,
  decryptField,
  encryptBankDetails,
  decryptBankDetails,
  maskAccountNumber,
  isEncrypted,
};
