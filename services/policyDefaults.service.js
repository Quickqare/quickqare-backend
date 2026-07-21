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

3. Cake and celebration orders (baked to order):
   - More than 48 hours before delivery: full refund.
   - 24 to 48 hours before delivery: 50% refund.
   - Less than 24 hours before delivery: no refund (baking has begun or the baker's slot cannot be refilled).
   - Grace period: if the order was placed less than 16 hours before delivery, it can be cancelled within 2 hours of booking for a full refund.

4. Service already started:
   - Once the partner has started work, refunds are generally not allowed unless support approves an exception.

5. No-show or incorrect address:
   - If the customer is unavailable or the address is incorrect, refund eligibility may be reduced.

6. Failed service or complaint:
   - If the service was not delivered properly, QuickQare support may offer a refund, re-service, or another resolution.

7. Refund timing:
   - Approved refunds may take 5 to 7 business days to reflect in the original payment method.

All refunds are reviewed based on booking status, service progress, and support validation.`,
  },
};

const PARTNER_POLICY_CONTENTS = {
  partner_terms: {
    title: "Partner Terms & Conditions",
    content: `Welcome to QuickQare Partner Platform.

By downloading the QuickQare Partner app and registering as a service partner, you agree to be bound by the following terms and conditions. Please read them carefully before proceeding.

1. Nature of the Relationship
   QuickQare is a technology platform that connects verified service professionals with customers seeking home services. By joining QuickQare, you operate as an independent service provider — not as an employee, agent, or representative of QuickQare. QuickQare does not direct your work or control how you perform services.

2. Eligibility & Registration
   - You must be at least 18 years of age to register as a partner.
   - You must complete the KYC verification process by submitting valid government-issued identity proof (Aadhaar, PAN, or equivalent) before you can accept jobs.
   - You must complete bank account or UPI verification to receive earnings.
   - Submitting false, forged, or misleading documents will result in immediate permanent account termination and may be reported to the relevant authorities.
   - QuickQare reserves the right to reject any registration at its discretion.

3. Service Categories & Skills
   - You may register for one or more service categories such as AC servicing, plumbing, mehendi, electrical work, or any other category supported by the platform.
   - You are responsible for ensuring you have the required skills, tools, equipment, and any legally required certifications for the services you offer.
   - QuickQare may periodically verify your capabilities and reserves the right to restrict your categories if service quality is found to be inadequate.

4. Job Assignment & Acceptance
   - Jobs are assigned based on your registered service categories, pincode coverage, availability, and proximity to the customer.
   - You will receive a notification for each assigned job and must acknowledge it within the specified time window.
   - You may decline a job before accepting, but repeated declines may reduce your priority in future assignments.
   - Once you accept a job, you are committed to completing it. Cancelling an accepted job impacts your performance rating and weekly cancellation count.

5. Cancellation Policy
   - You are permitted a limited number of cancellations per rolling 7-day period (as set by QuickQare and communicated through the app).
   - Exceeding the permitted weekly cancellation limit will result in a temporary automatic suspension of your account.
   - Repeated or sustained violations will result in longer suspensions or permanent termination.

6. Service Conduct
   - You must arrive at the customer's location on or before the scheduled time.
   - You must complete the job to the standard expected for the service category.
   - You must carry all necessary tools and equipment to perform the job.
   - You must behave respectfully and professionally with customers at all times.
   - You must not request or accept cash or any payment directly from customers outside the QuickQare platform.
   - You must not share, misuse, or retain customer contact details, addresses, or any personal information beyond what is necessary for the job.
   - Any form of harassment, misconduct, fraud, or damage to customer property will result in immediate suspension, termination, and potential legal action.

7. Team & Helper Jobs
   - QuickQare may assign jobs requiring a team of two or more partners.
   - You may invite helpers from within the platform to assist on specific jobs.
   - Each team member's earnings are calculated based on their assigned payout ratio for that job.
   - All team members are individually bound by these terms for the jobs they participate in.

8. Earnings & Commission
   - Your gross earning per job is the job value after any customer discounts applied by QuickQare.
   - A platform commission is deducted from your gross earning. The commission percentage may vary based on your active subscription plan and service category.
   - Your net earning (after commission) is credited to your QuickQare wallet after a 48-hour settlement period from job completion.
   - QuickQare reserves the right to revise commission rates with prior notice through the app.

9. Wallet & Withdrawals
   - Earnings are held in your QuickQare wallet in a pending balance until the settlement period completes, after which they move to your withdrawable balance.
   - You may initiate a withdrawal to your verified bank account or UPI ID once your withdrawable balance meets the minimum threshold.
   - Withdrawals are subject to processing time and verification by QuickQare.
   - QuickQare is not liable for delays caused by banking infrastructure or third-party payment processors.

10. Subscription Plans
    - QuickQare offers subscription plans that may affect your commission rate, job priority, and platform features.
    - Plan details, pricing, and benefits are displayed in the app and may be updated from time to time.
    - Unused plan benefits do not carry forward and are non-refundable unless explicitly stated.

11. Ratings & Performance
    - Customers may rate you after each completed job. Your average rating is visible on your profile.
    - Consistently low ratings may result in reduced job assignments or suspension pending review.
    - QuickQare may reach out for quality improvement support if your rating falls below the acceptable threshold.

12. Account Suspension & Termination
    QuickQare may suspend or terminate your partner account in the following circumstances:
    - Failing or refusing to complete KYC or bank verification.
    - Providing false information during registration or verification.
    - Repeated cancellations beyond permitted limits.
    - Customer complaints of misconduct, fraud, or unprofessional behaviour.
    - Accepting payments outside the platform.
    - Any activity that violates these terms or applicable law.
    Upon termination, any settled earnings in your withdrawable balance will be paid out after a review period. Pending earnings may be forfeited depending on the reason for termination.

13. Amendments
    QuickQare may update these terms at any time. You will be notified through the app. Continued use of the platform after the effective date of any change constitutes acceptance of the updated terms.

14. Governing Law
    These terms are governed by the laws of India. Any disputes arising from this agreement shall be subject to the jurisdiction of the courts in India.

For support or grievances, contact QuickQare through the Help section of the partner app.`,
  },

  partner_privacy: {
    title: "Partner Privacy Policy",
    content: `At QuickQare, we take your privacy seriously. This policy explains what personal information we collect from service partners, how we use it, and how we protect it.

1. Information We Collect

   a. Identity & Contact Information
      - Full name, phone number, gender, and date of birth collected during registration.
      - Email address if provided.

   b. KYC Documents
      - Government-issued identity proof such as Aadhaar card or PAN card, uploaded during the verification process.
      - Photographs or scans of these documents are stored securely for compliance and verification purposes.

   c. Bank & Payment Details
      - Bank account number, IFSC code, and account holder name, or UPI ID provided for payout processing.

   d. Location Data
      - Your approximate location is used at the time of job assignment to match you with nearby customers.
      - Your real-time location is shared with the assigned customer during the active phase of a booking (from job start to job completion).
      - Location is not tracked or stored continuously outside of active job sessions.

   e. Device & App Data
      - Device type, operating system version, and app version for troubleshooting and compatibility.
      - Firebase Cloud Messaging (FCM) token for delivering job notifications and alerts to your device.

   f. Job & Performance Data
      - Booking history, job completion records, cancellation history, earnings, wallet transactions, and customer ratings.

2. How We Use Your Information

   - To verify your identity and eligibility to operate as a partner on the platform.
   - To assign jobs to you based on your location, service categories, and availability.
   - To calculate your earnings, process settlements, and disburse payouts to your bank or UPI account.
   - To send you job alerts, booking updates, payment confirmations, and important account notifications via push notifications and SMS.
   - To monitor service quality, resolve customer complaints, and take action in case of policy violations.
   - To maintain platform safety, prevent fraud, and comply with legal obligations.

3. KYC Document Handling
   - KYC documents are stored on secure cloud infrastructure and accessed only by authorised QuickQare personnel for verification purposes.
   - KYC documents are never shared with customers, third-party advertisers, or any unauthorised party.
   - Documents are retained for the period required by applicable law even after account deletion.

4. Bank & UPI Details
   - Your bank account and UPI details are used solely for processing job earnings and refunds.
   - These details are stored securely and are never shared with customers or third parties outside the payment processing flow.
   - Payouts are processed through regulated banking channels and payment service providers.

5. Location Data
   - Location data is used only for job matching and active job tracking.
   - Your live location during an active job is visible to the assigned customer for service coordination.
   - Once the job is marked complete, live location sharing stops immediately.
   - We do not sell or share location data with advertisers or unrelated third parties.

6. What Customers Can See
   - During an active booking, customers can see your name, profile photo (if uploaded), service category, and live location.
   - Your phone number is not directly shared with customers. All contact is facilitated through the platform.

7. Third-Party Services
   QuickQare uses the following third-party services to operate the platform. These services may process some of your data in accordance with their own privacy policies:
   - Firebase (Google) — push notifications and authentication.
   - Cloudinary — secure storage of profile images and KYC documents.
   - Banking & UPI partners — payout processing.
   - Cloud hosting providers — secure server and database infrastructure.

8. Data Retention
   - Your personal data is retained for as long as your account is active.
   - If you delete your account, your data is retained for a minimum period as required under applicable Indian law (including financial and tax compliance requirements) and then securely deleted.
   - KYC and financial records may be retained for up to 7 years as required by law.

9. Your Rights
   - You may request to view or correct your personal information through the app at any time.
   - You may request account deletion through the Delete Account option in your profile. Deletion is subject to the retention periods mentioned above.
   - For any data-related request or concern, contact QuickQare support through the Help section of the partner app.

10. Security
    - We use industry-standard encryption and access controls to protect your data.
    - Access to sensitive data is restricted to authorised personnel only.
    - We do not sell your personal data to any third party.

11. Changes to This Policy
    QuickQare may update this Privacy Policy from time to time. Any significant changes will be communicated through the app. Continued use of the platform after updates constitutes acceptance of the revised policy.

For privacy concerns or data requests, contact us through the Help section of the QuickQare Partner app.`,
  },
};

function resolveDefaultPolicy(type = "") {
  const normalized = String(type || "").toLowerCase().trim();
  return DEFAULT_POLICY_CONTENTS[normalized] || PARTNER_POLICY_CONTENTS[normalized] || null;
}

module.exports = {
  DEFAULT_POLICY_CONTENTS,
  PARTNER_POLICY_CONTENTS,
  resolveDefaultPolicy,
};
