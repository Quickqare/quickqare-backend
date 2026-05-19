const DEFAULT_POLICY_CONTENTS = {
  about: {
    title: "About Us",
    content: `QuickQare connects customers with trusted home service partners for AC, mehendi, plumbing, and other supported services in eligible pin codes.

What you can do in the app:
1. Browse services by category and subcategory.
2. Check availability for your area before booking.
3. Book securely and pay through the app.
4. Track booking status and partner assignment.
5. Read terms, privacy policy, and refund rules anytime.

Our goal is to make home service booking simple, transparent, and reliable for customers while giving verified partners a clear platform to receive jobs.`,
  },
  terms: {
    title: "Terms & Conditions",
    content: `Welcome to QuickQare.

QuickQare is a home services platform that helps customers book service professionals for services such as AC, mehendi, plumbing, and other supported categories in eligible pin code areas.

By using the app, you agree to the following:
1. You will provide accurate personal, address, and booking information.
2. Service availability depends on your pin code, selected service, date, and partner availability.
3. Booking confirmation is subject to payment verification and service capacity.
4. Prices, discounts, and service options may change from time to time.
5. You must not misuse the platform, create fake bookings, or interfere with service execution.
6. QuickQare may suspend or block accounts involved in fraud, abuse, repeated cancellations, or policy violations.
7. Customer and partner data is used only to provide the booking and support experience.

QuickQare may update these terms when needed. Continued use of the app means you accept the updated terms.`,
  },
  privacy: {
    title: "Privacy Policy",
    content: `QuickQare respects your privacy and uses your information only to operate the service.

What we collect:
1. Name, phone number, gender, and profile details you provide.
2. Address, pin code, booking history, and service preferences.
3. Payment status and transaction references from the payment gateway.
4. Device and app data needed for login, notifications, and service delivery.

How we use it:
1. To create and manage your account.
2. To assign the right partner and confirm service availability.
3. To process payments, refunds, complaints, and support requests.
4. To improve app performance, booking reliability, and service quality.

How we protect it:
1. Access to sensitive data is restricted to authorized systems.
2. We do not sell your personal data.
3. We store only the data needed to run the platform and meet legal requirements.

Third-party services:
QuickQare may use messaging, maps, cloud storage, and payment providers to complete your booking. Their own privacy terms may also apply.

If you have a privacy concern, contact support through the app or admin panel.`,
  },
  refund: {
    title: "Cancellation & Refund Policy",
    content: `Cancellation and refund rules for QuickQare:

1. Booking not yet paid:
   - If the booking is not completed in payment time, the slot lock expires automatically and the booking is released.

2. Customer cancellation before service:
   - More than 24 hours before service: usually eligible for a full refund.
   - 4 to 24 hours before service: partial refund may apply.
   - 1 to 4 hours before service: smaller partial refund may apply.
   - Less than 1 hour before service or after partner arrival: refund may be limited or not available depending on service progress.

3. Service already started:
   - Once the partner has started work, refunds are generally not allowed unless support approves an exception.

4. No-show or incorrect address:
   - If the customer is unavailable or the address is incorrect, refund eligibility may be reduced.

5. Failed service or complaint:
   - If the service was not delivered properly, QuickQare support may offer a refund, re-service, or another resolution.

6. Refund timing:
   - Approved refunds may take 5 to 7 business days to reflect in the original payment method.

All refunds are reviewed based on booking status, service progress, and support validation.`,
  },
};

function resolveDefaultPolicy(type = "") {
  const normalized = String(type || "").toLowerCase().trim();
  return DEFAULT_POLICY_CONTENTS[normalized] || null;
}

module.exports = {
  DEFAULT_POLICY_CONTENTS,
  resolveDefaultPolicy,
};
