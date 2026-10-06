const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = process.env.RESEND_FROM_EMAIL || "QuickQare Admin <noreply@quickqare.in>";

async function sendAdminTwoFaCode(toEmail, code, expiresMinutes = 5) {
  await resend.emails.send({
    from: FROM,
    to: toEmail,
    subject: `${code} — Your QuickQare Admin Login Code`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#f9fafb;border-radius:12px;">
        <div style="text-align:center;margin-bottom:28px;">
          <div style="display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;background:#0A0A0A;border-radius:10px;">
            <span style="color:#fff;font-weight:800;font-size:18px;">Q</span>
          </div>
          <h2 style="margin:12px 0 4px;font-size:18px;color:#111827;">QuickQare Admin</h2>
          <p style="margin:0;color:#6b7280;font-size:13px;">Operations Control Panel</p>
        </div>

        <div style="background:#ffffff;border-radius:10px;padding:28px 24px;border:1px solid #e5e7eb;text-align:center;">
          <p style="margin:0 0 16px;color:#374151;font-size:14px;">Your one-time login code is:</p>
          <div style="letter-spacing:0.35em;font-size:36px;font-weight:800;color:#0A0A0A;font-family:monospace;margin-bottom:16px;">
            ${code}
          </div>
          <p style="margin:0;color:#9ca3af;font-size:12px;">Expires in ${expiresMinutes} minutes. Do not share this code.</p>
        </div>

        <p style="text-align:center;margin-top:20px;color:#d1d5db;font-size:11px;">
          QuickQare · If you did not request this, ignore this email.
        </p>
      </div>
    `,
  });
}

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Team alert (partner not seen / late / paused …). `lines` are plain text —
// escaped here, since they carry partner/customer-entered values.
async function sendOpsAlertEmail(toList, subject, lines = []) {
  await resend.emails.send({
    from: FROM,
    to: toList,
    subject: `[QuickQare Ops] ${subject}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 12px;font-size:17px;color:#111827;">${escapeHtml(subject)}</h2>
        ${lines
          .map((line) => `<p style="margin:0 0 8px;color:#374151;font-size:14px;">${escapeHtml(line)}</p>`)
          .join("")}
        <p style="margin-top:20px;color:#9ca3af;font-size:12px;">Sent automatically by QuickQare. The booking's Timeline in the admin panel has the same entry.</p>
      </div>
    `,
  });
}

module.exports = { sendAdminTwoFaCode, sendOpsAlertEmail };
