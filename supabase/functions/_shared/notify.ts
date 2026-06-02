// shared multi-channel notification layer.
// Channel #1: Email via Resend. WhatsApp/SMS are stubs for a later phase
// (WhatsApp requires WhatsApp Business API approval).

export type Channel = "email" | "whatsapp" | "sms";

export interface NotifyInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendNotification(channel: Channel, input: NotifyInput): Promise<{ ok: boolean; error?: string }> {
  switch (channel) {
    case "email":
      return await sendEmail(input);
    case "whatsapp":
      return { ok: false, error: "ערוץ WhatsApp עדיין לא מוגדר (שלב ב')" };
    case "sms":
      return { ok: false, error: "ערוץ SMS עדיין לא מוגדר (שלב ב')" };
    default:
      return { ok: false, error: `ערוץ לא מוכר: ${channel}` };
  }
}

async function sendEmail({ to, subject, html, text }: NotifyInput): Promise<{ ok: boolean; error?: string }> {
  const key = Deno.env.get("RESEND_API_KEY");
  // Resend's onboarding sender works out of the box for testing; set RESEND_FROM
  // to your own verified domain sender for production.
  const from = Deno.env.get("RESEND_FROM") ?? "AmitVet <onboarding@resend.dev>";
  if (!key) return { ok: false, error: "RESEND_API_KEY חסר" };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html, text }),
  });
  if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${await res.text()}` };
  return { ok: true };
}
