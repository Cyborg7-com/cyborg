// Email OTP for signup verification.
//
// Generates a 6-digit code, hashes it (the plaintext code never touches the
// database), and sends it via Resend. When RESEND_API_KEY is unset we fall
// back to "dev mode": the code is logged and returned to the caller so the
// signup flow works without an email provider — mirroring the JWT dev-secret
// pattern used elsewhere in the relay. Dev mode is disabled in production.

import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { Resend } from "resend";

export const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const OTP_MAX_ATTEMPTS = 5;
// Minimum gap between (re)sends to the same email — anti-email-bomb. The UI
// shows a matching countdown so "Resend" is disabled until it elapses.
export const OTP_RESEND_COOLDOWN_MS = 30 * 1000;

export type OtpPurpose = "signup" | "reset";

// Milliseconds the caller must wait before another send is allowed, given the
// last send time. 0 = may send now.
export function resendCooldownRemainingMs(lastSentAt: Date): number {
  return Math.max(0, OTP_RESEND_COOLDOWN_MS - (Date.now() - lastSentAt.getTime()));
}

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM ?? "Cyborg7 <onboarding@resend.dev>";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function hashOtpCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export function verifyOtpCode(code: string, codeHash: string): boolean {
  const provided = Buffer.from(hashOtpCode(code), "hex");
  const expected = Buffer.from(codeHash, "hex");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export function otpExpiry(): Date {
  return new Date(Date.now() + OTP_TTL_MS);
}

export interface OtpSendResult {
  delivered: boolean;
  // Only populated in dev mode (no RESEND_API_KEY, non-production) so callers
  // can surface the code without a real inbox. Never set in production.
  devCode?: string;
}

export async function sendOtpEmail(
  email: string,
  code: string,
  purpose: OtpPurpose = "signup",
): Promise<OtpSendResult> {
  const lead =
    purpose === "reset"
      ? "Your Cyborg7 password reset code is:"
      : "Your Cyborg7 verification code is:";
  const subject =
    purpose === "reset"
      ? `Your Cyborg7 password reset code: ${code}`
      : `Your Cyborg7 verification code: ${code}`;

  if (!resend) {
    if (IS_PRODUCTION) {
      throw new Error("RESEND_API_KEY is not configured");
    }
    console.log(`[email-otp] DEV MODE — ${purpose} code for ${email}: ${code}`);
    return { delivered: false, devCode: code };
  }

  await resend.emails.send({
    from: EMAIL_FROM,
    to: email,
    subject,
    text: `${lead} ${code}. It expires in 10 minutes. If you didn't request this, you can ignore this email.`,
    html: [
      '<div style="font-family:system-ui,-apple-system,sans-serif;color:#111">',
      `<p>${lead}</p>`,
      `<p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:16px 0">${code}</p>`,
      "<p>It expires in 10 minutes. If you didn't request this, you can ignore this email.</p>",
      "</div>",
    ].join(""),
  });

  return { delivered: true };
}

// Workspace invitation email. Sends a "Join {workspaceName}" CTA button linking
// to the invite landing URL plus the raw link to copy. In dev mode (no
// RESEND_API_KEY) the URL is logged instead of throwing, mirroring sendOtpEmail.
export async function sendInvitationEmail(
  email: string,
  inviteUrl: string,
  workspaceName: string,
): Promise<void> {
  const subject = `You've been invited to ${workspaceName} on Cyborg7`;

  if (!resend) {
    if (IS_PRODUCTION) {
      throw new Error("RESEND_API_KEY is not configured");
    }
    console.log(`[email-otp] DEV MODE — invite for ${email} to ${workspaceName}: ${inviteUrl}`);
    return;
  }

  await resend.emails.send({
    from: EMAIL_FROM,
    to: email,
    subject,
    text: `You've been invited to join ${workspaceName} on Cyborg7. Accept your invitation: ${inviteUrl}`,
    html: [
      '<div style="font-family:system-ui,-apple-system,sans-serif;color:#111;max-width:480px">',
      `<p>You've been invited to join <strong>${workspaceName}</strong> on Cyborg7.</p>`,
      `<p style="margin:24px 0"><a href="${inviteUrl}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">Join ${workspaceName}</a></p>`,
      "<p>Or copy and paste this link into your browser:</p>",
      `<p style="word-break:break-all"><a href="${inviteUrl}">${inviteUrl}</a></p>`,
      "</div>",
    ].join(""),
  });
}
