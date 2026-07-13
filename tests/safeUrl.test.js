/**
 * Link-scheme guard for admin-supplied URLs that clients render into an <a href>
 * (home banners, footer social links).
 *
 * React does not block `javascript:` hrefs — it only warns — so an unchecked
 * link here is stored XSS on the customer's origin, with their session cookie
 * attached. See utils/safeUrl.js.
 */
const { isSafeLinkUrl } = require("../utils/safeUrl");

describe("isSafeLinkUrl", () => {
  test("allows absolute http(s) links", () => {
    expect(isSafeLinkUrl("https://quickqare.in/offers")).toBe(true);
    expect(isSafeLinkUrl("http://example.com")).toBe(true);
  });

  test("allows an empty value — that just means 'no link'", () => {
    expect(isSafeLinkUrl("")).toBe(true);
    expect(isSafeLinkUrl("   ")).toBe(true);
    expect(isSafeLinkUrl(undefined)).toBe(true);
    expect(isSafeLinkUrl(null)).toBe(true);
  });

  test("rejects script-bearing schemes", () => {
    expect(isSafeLinkUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeLinkUrl("JavaScript:alert(1)")).toBe(false);
    expect(isSafeLinkUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeLinkUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  test("rejects payloads obfuscated with whitespace the URL parser strips", () => {
    // The parser removes tabs/newlines before resolving the scheme, so these
    // normalise to `javascript:` — which is exactly why this isn't a regex.
    expect(isSafeLinkUrl("java\nscript:alert(1)")).toBe(false);
    expect(isSafeLinkUrl("java\tscript:alert(1)")).toBe(false);
    expect(isSafeLinkUrl("  javascript:alert(1)  ")).toBe(false);
  });

  test("rejects anything that isn't an absolute URL", () => {
    expect(isSafeLinkUrl("/offers")).toBe(false);
    expect(isSafeLinkUrl("not a url")).toBe(false);
  });
});
