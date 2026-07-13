// Scheme guard for admin-supplied links that clients render into an <a href>
// (home banners, footer social links).
//
// React does NOT block `javascript:` hrefs — it only logs a dev-time warning and
// still renders them. So a banner saved with
//   linkUrl: "javascript:fetch('/api/user/me',{method:'DELETE'})"
// executes on the customer's own origin the moment they click it, with their
// session cookie attached. The httpOnly cookie stops the token being *read*, but
// the script still acts as the victim against our API.
//
// Enforced here at write time; the web app re-checks at render time, because
// rows written before this guard existed are still in the database.

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:"]);

// True for an empty value (meaning "no link", which every caller treats as
// valid) and for absolute http/https URLs. False for everything else —
// javascript:, data:, vbscript:, and anything the URL parser rejects.
//
// Uses the WHATWG URL parser rather than a regex on purpose: it strips the tabs
// and newlines that "java\nscript:alert(1)" hides behind before resolving the
// scheme, so obfuscated payloads normalise to `javascript:` and get rejected.
function isSafeLinkUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return true;
  try {
    return SAFE_LINK_PROTOCOLS.has(new URL(raw).protocol);
  } catch {
    return false;
  }
}

module.exports = { isSafeLinkUrl, SAFE_LINK_PROTOCOLS };
