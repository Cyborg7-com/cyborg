import { json, error } from "@sveltejs/kit";
import { Resend } from "resend";
import { env } from "$env/dynamic/private";
import type { RequestHandler } from "./$types";

const categoryLabels: Record<string, string> = {
  bug: "\u{1f41b} Bug Report",
  feature: "✨ Feature Request",
  general: "\u{1f4ac} General Feedback",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const POST: RequestHandler = async ({ request }) => {
  const resend = new Resend(env.RESEND_API_KEY || "re_placeholder");
  const from = env.EMAIL_FROM || "Cyborg7 <noreply@cyborg7.com>";
  const recipients = (env.FEEDBACK_RECIPIENTS || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  if (recipients.length === 0) {
    return error(503, "Feedback recipients not configured");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error(400, "Invalid JSON");
  }

  const { category, description, screenshot } = body as {
    category: string;
    description: string;
    screenshot?: string | null;
  };

  if (!description?.trim() || !["bug", "feature", "general"].includes(category)) {
    return error(400, "Invalid feedback data");
  }

  const label = categoryLabels[category] ?? category;

  const attachments: Array<{ filename: string; content: Buffer }> = [];
  if (screenshot) {
    const match = screenshot.match(/^data:image\/(\w+);base64,(.+)$/);
    if (match) {
      attachments.push({
        filename: `screenshot.${match[1]}`,
        content: Buffer.from(match[2], "base64"),
      });
    }
  }

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px;">
      <h2 style="margin: 0 0 16px;">${label}</h2>
      <div style="padding: 16px; background: #f8fafc; border-radius: 8px; white-space: pre-wrap;">${escapeHtml(description)}</div>
      ${attachments.length > 0 ? '<p style="margin-top: 16px; color: #64748b; font-size: 13px;">📎 Screenshot attached</p>' : ""}
    </div>
  `;

  try {
    await resend.emails.send({
      from,
      to: recipients,
      subject: `[Cyborg7 Feedback] ${label}`,
      html,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  } catch (e) {
    console.error("Failed to send feedback email:", e);
    return error(500, "Failed to send feedback");
  }

  return json({ ok: true });
};
