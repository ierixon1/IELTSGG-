const RESEND_ENDPOINT = 'https://api.resend.com/emails';

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required email configuration: ${name}`);
  return value;
};

export function isEmailDeliveryConfigured() {
  return Boolean(
    process.env.RESEND_API_KEY?.trim() &&
    process.env.EMAIL_FROM?.trim() &&
    process.env.APP_URL?.trim(),
  );
}

export async function sendPasswordResetEmail(params: { to: string; token: string }) {
  const apiKey = required('RESEND_API_KEY');
  const from = required('EMAIL_FROM');
  const appUrl = required('APP_URL').replace(/\/$/, '');
  const resetUrl = `${appUrl}/reset-password?email=${encodeURIComponent(params.to)}&token=${encodeURIComponent(params.token)}`;
  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [params.to],
      subject: 'Reset your Ever Study password',
      html: `<div style="font-family:Arial,sans-serif;line-height:1.6;max-width:600px"><h2>Reset your password</h2><p>We received a request to reset your Ever Study password.</p><p><a href="${resetUrl}" style="display:inline-block;padding:10px 16px;background:#6c4dff;color:#fff;text-decoration:none;border-radius:8px">Reset password</a></p><p>This link expires in 15 minutes. If you did not request this, you can ignore this email.</p></div>`,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Password reset email failed (${response.status}): ${detail.slice(0, 300)}`);
  }
}
