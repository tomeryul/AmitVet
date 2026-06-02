// AmitVet · appointment-action
// Public, token-based confirm/cancel from a reminder email link.
// Security is via the unguessable one-time token (appointment_tokens), not auth.
// Deploy with "Verify JWT" turned OFF for this function.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const action = url.searchParams.get("action");

  if (!token || (action !== "confirm" && action !== "cancel")) {
    return page("קישור לא תקין", "הקישור חסר פרטים או שגוי.");
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE);

  const { data: tok } = await db
    .from("appointment_tokens").select("appointment_id").eq("token", token).maybeSingle();
  if (!tok) return page("קישור לא תקין", "הקישור פג תוקף או אינו קיים.");

  const { data: appt } = await db
    .from("appointments").select("id, status").eq("id", tok.appointment_id).single();
  if (!appt) return page("התור לא נמצא", "ייתכן שהתור נמחק.");

  if (appt.status !== "requested" && appt.status !== "confirmed") {
    return page("לא ניתן לעדכן", `התור כבר במצב: ${statusHe(appt.status)}.`);
  }

  const newStatus = action === "confirm" ? "confirmed" : "cancelled";
  await db.from("appointments").update({ status: newStatus }).eq("id", appt.id);
  await db.from("appointment_tokens").update({ used_at: new Date().toISOString() }).eq("token", token);

  // When cancelled, stop any reminders still queued for this appointment.
  if (newStatus === "cancelled") {
    await db.from("notifications").update({ status: "cancelled" })
      .eq("appointment_id", appt.id).eq("status", "scheduled");
  }

  return action === "confirm"
    ? page("התור אושר ✓", "תודה! נתראה בקרוב במרפאה.")
    : page("התור בוטל", "התור בוטל בהצלחה. אפשר לקבוע תור חדש דרך האתר בכל עת.");
});

function statusHe(s: string): string {
  return ({ requested: "ממתין לאישור", confirmed: "מאושר", completed: "הושלם", cancelled: "בוטל", no_show: "לא הגיע" } as Record<string, string>)[s] ?? s;
}

function page(title: string, body: string): Response {
  const html = `<!doctype html><html dir="rtl" lang="he"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>AmitVet</title></head>
    <body style="font-family:Arial,Helvetica,sans-serif;background:#f5f1e6;display:grid;place-items:center;min-height:100vh;margin:0;color:#2d2924">
      <div style="max-width:420px;background:#fff;border-radius:28px;padding:40px 32px;box-shadow:0 18px 48px -16px rgba(80,70,40,.2);text-align:center">
        <div style="width:60px;height:60px;border-radius:18px;background:#f2785c;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:30px">🐾</div>
        <h1 style="color:#2e5a32;font-size:22px;margin:16px 0 8px">${title}</h1>
        <p style="font-size:15px;color:#56504a;line-height:1.6;margin:0">${body}</p>
      </div></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
