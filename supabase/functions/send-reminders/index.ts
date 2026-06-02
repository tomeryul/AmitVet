// AmitVet · send-reminders
// Invoked on a schedule (pg_cron + pg_net, every ~15m). Two phases:
//   1) enqueue: create scheduled reminder rows (24h + 2h) for confirmed,
//      upcoming appointments — idempotent via unique(appointment_id, template).
//   2) dispatch: send any scheduled reminders whose send_at has passed.
// Secrets (set in Supabase, never in docs/): RESEND_API_KEY, RESEND_FROM, CRON_SECRET.
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are injected automatically.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { sendNotification } from "../_shared/notify.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET");
const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

Deno.serve(async (req) => {
  // Only the scheduler (or you, with the secret) may invoke this.
  if (CRON_SECRET && req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const db = createClient(SUPABASE_URL, SERVICE_ROLE);
  const now = new Date();
  try {
    const enqueued = await enqueue(db, now);
    const sent = await dispatch(db, now);
    return Response.json({ ok: true, enqueued, sent });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});

// ---- phase 1: enqueue ----
async function enqueue(db: any, now: Date): Promise<number> {
  const horizon = new Date(now.getTime() + 25 * 3600 * 1000).toISOString();
  const { data: appts, error } = await db
    .from("appointments")
    .select("id, client_id, scheduled_at, type, pet:pets(name)")
    .eq("status", "confirmed")
    .gte("scheduled_at", now.toISOString())
    .lte("scheduled_at", horizon);
  if (error) throw error;

  let n = 0;
  for (const a of appts ?? []) {
    const token = await getOrCreateToken(db, a.id);
    const sched = new Date(a.scheduled_at).getTime();
    const plans = [
      { template: "reminder_24h", at: new Date(sched - 24 * 3600 * 1000) },
      { template: "reminder_2h", at: new Date(sched - 2 * 3600 * 1000) },
    ];
    for (const p of plans) {
      // Skip a reminder whose window is already well past (avoid late noise).
      if (p.at.getTime() < now.getTime() - 30 * 60 * 1000) continue;
      const { error: insErr, data } = await db
        .from("notifications")
        .upsert({
          recipient_id: a.client_id,
          appointment_id: a.id,
          channel: "email",
          template: p.template,
          send_at: p.at.toISOString(),
          payload: { token, pet_name: a.pet?.name ?? null, scheduled_at: a.scheduled_at, type: a.type },
        }, { onConflict: "appointment_id,template", ignoreDuplicates: true })
        .select("id");
      if (!insErr && data && data.length) n++;
    }
  }
  return n;
}

async function getOrCreateToken(db: any, appointmentId: number): Promise<string> {
  const { data: existing } = await db
    .from("appointment_tokens").select("token").eq("appointment_id", appointmentId).limit(1).maybeSingle();
  if (existing?.token) return existing.token;
  const { data: created } = await db
    .from("appointment_tokens").insert({ appointment_id: appointmentId }).select("token").single();
  return created.token;
}

// ---- phase 2: dispatch ----
async function dispatch(db: any, now: Date): Promise<number> {
  const { data: due, error } = await db
    .from("notifications")
    .select("*, recipient:profiles(email,name)")
    .eq("status", "scheduled")
    .lte("send_at", now.toISOString())
    .limit(50);
  if (error) throw error;

  let sent = 0;
  for (const note of due ?? []) {
    const to = note.recipient?.email;
    if (!to) { await mark(db, note.id, "failed", "ללקוח אין כתובת אימייל"); continue; }
    const { subject, html, text } = buildEmail(note);
    const r = await sendNotification(note.channel, { to, subject, html, text });
    if (r.ok) { await mark(db, note.id, "sent"); sent++; }
    else { await mark(db, note.id, "failed", r.error); }
  }
  return sent;
}

async function mark(db: any, id: number, status: string, error?: string) {
  await db.from("notifications").update({
    status,
    error: error ?? null,
    sent_at: status === "sent" ? new Date().toISOString() : null,
  }).eq("id", id);
}

function buildEmail(note: any): { subject: string; html: string; text: string } {
  const p = note.payload ?? {};
  const when = new Date(p.scheduled_at).toLocaleString("he-IL", { dateStyle: "full", timeStyle: "short" });
  const base = `${FUNCTIONS_URL}/appointment-action?apikey=${ANON}&token=${p.token}`;
  const confirm = `${base}&action=confirm`;
  const cancel = `${base}&action=cancel`;
  const lead = note.template === "reminder_2h" ? "התור שלך בעוד כשעתיים" : "תזכורת: יש לך תור מחר";
  const pet = p.pet_name ? ` עבור ${p.pet_name}` : "";
  const name = note.recipient?.name ?? "";
  const subject = `AmitVet · ${lead}`;
  const html = `<!doctype html><html dir="rtl" lang="he"><body style="font-family:Arial,Helvetica,sans-serif;background:#f5f1e6;padding:24px;color:#2d2924;margin:0">
    <div style="max-width:480px;margin:auto;background:#fff;border-radius:22px;padding:28px;box-shadow:0 8px 24px rgba(80,70,40,.1)">
      <div style="font-size:22px;font-weight:700;color:#1a1714;margin-bottom:6px">🐾 AmitVet</div>
      <h2 style="color:#2e5a32;font-size:20px;margin:12px 0">${lead}${pet}</h2>
      <p style="font-size:15px;line-height:1.6;margin:0 0 8px">שלום ${name},<br>נזכיר שיש לך תור במרפאה:</p>
      <p style="font-size:16px;font-weight:700;background:#d8e9d3;color:#2e5a32;padding:12px 16px;border-radius:12px;text-align:center">${when}</p>
      <p style="font-size:14px;margin:16px 0 6px">אפשר לאשר או לבטל ישירות מכאן:</p>
      <p style="text-align:center;margin:8px 0 4px">
        <a href="${confirm}" style="display:inline-block;background:#5a8a5e;color:#fff;text-decoration:none;padding:11px 22px;border-radius:12px;font-weight:700;margin:4px">אישור הגעה</a>
        <a href="${cancel}" style="display:inline-block;background:#f3d8d1;color:#b85544;text-decoration:none;padding:11px 22px;border-radius:12px;font-weight:700;margin:4px">ביטול התור</a>
      </p>
      <p style="font-size:12px;color:#a89e8f;margin-top:18px">אם הכפתורים לא עובדים, אפשר להשיב להודעה הזו.</p>
    </div></body></html>`;
  const text = `${lead}${pet}: ${when}.\nאישור הגעה: ${confirm}\nביטול: ${cancel}`;
  return { subject, html, text };
}
