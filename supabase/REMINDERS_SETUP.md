# הקמת תזכורות תור אוטומטיות (P0)

מדריך חד-פעמי. נוח לבצע **ממחשב**. בסוף: כל תור מאושר (`confirmed`) עתידי יקבל
אוטומטית תזכורת אימייל 24 שעות ושעתיים מראש, עם כפתורי **אישור / ביטול** ישירות מהמייל.

> כל הקוד כבר בריפו. צריך רק להריץ SQL, לפרוס שתי פונקציות, ולחבר תזמון.

---

## שלב 1 — מסד הנתונים (קל, אפשר גם מהפלאפון)

Supabase → **SQL Editor → New query** → הדביקו והריצו את התוכן של
[`supabase/migration_v3.sql`](migration_v3.sql). זה מוסיף את סטטוס `no_show`,
את טבלת `notifications` ואת `appointment_tokens`.

---

## שלב 2 — חשבון Resend (שליחת אימייל)

1. היכנסו ל-[resend.com](https://resend.com) → **Sign up** (חינם, ~3,000 מיילים/חודש).
2. **API Keys → Create API Key** → העתיקו את המפתח (מתחיל ב-`re_...`). שמרו בצד.
3. **שולח (From):**
   - **לבדיקה מהירה:** דלגו — ברירת המחדל בקוד היא `onboarding@resend.dev`
     ש-Resend מאפשר לשלוח ממנו מיד (מגיע רק לכתובת שאיתה נרשמתם).
   - **לפרודקשן:** **Domains → Add Domain**, הוסיפו את רשומות ה-DNS שמציגים
     (SPF/DKIM), ואז השולח יהיה משהו כמו `AmitVet <noreply@your-domain.com>`.

---

## שלב 3 — פריסת שתי ה-Edge Functions

Supabase → **Edge Functions → Create a function** (עורך בדפדפן). צרו **שתי** פונקציות:

| שם הפונקציה | קובץ מקור בריפו | Verify JWT |
|---|---|---|
| `send-reminders` | `supabase/functions/send-reminders/index.ts` | מופעל (ברירת מחדל) |
| `appointment-action` | `supabase/functions/appointment-action/index.ts` | **כבוי** ⚠️ |

לכל פונקציה: העתיקו את תוכן הקובץ אל העורך ולחצו **Deploy**.
את `appointment-action` חובה לפרוס עם **Verify JWT = Off** (היא נפתחת מקישור במייל,
בלי התחברות; האבטחה היא דרך הטוקן החד-פעמי).

> שתי הפונקציות משתמשות בקובץ המשותף `supabase/functions/_shared/notify.ts` —
> אם אתם פורסים דרך ה-CLI (`supabase functions deploy`) הוא נכלל אוטומטית.
> בעורך הדפדפן, צרו גם אותו תחת `_shared/notify.ts`.

---

## שלב 4 — Secrets (סודות — ב-Supabase בלבד, לעולם לא ב-docs/)

Supabase → **Edge Functions → Secrets** (או **Project Settings → Edge Functions**) →
הוסיפו:

| Secret | ערך |
|---|---|
| `RESEND_API_KEY` | המפתח מ-Resend (`re_...`) |
| `RESEND_FROM` | (אופציונלי) `AmitVet <noreply@your-domain.com>` |
| `CRON_SECRET` | המציאו מחרוזת אקראית ארוכה (שמרו אותה — צריך אותה בשלב 5) |

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` קיימים אוטומטית — אל תגדירו.

---

## שלב 5 — תזמון אוטומטי (pg_cron)

Supabase → **SQL Editor** → פתחו את [`supabase/setup_cron.sql`](setup_cron.sql),
החליפו את שני ה-placeholders והריצו:

- `<PROJECT_REF>` — מתוך כתובת הפרויקט `https://<REF>.supabase.co`
- `<CRON_SECRET>` — אותה מחרוזת שהגדרתם בשלב 4

זה מריץ את `send-reminders` כל 15 דקות.

---

## בדיקה ידנית

1. באתר (כווטרינר) צרו תור ושנו את הסטטוס שלו ל-**מאושר**, עם מועד בעוד ~24 שעות.
   ודאו שללקוח של התור יש כתובת אימייל בפרופיל.
2. הריצו את הפונקציה ידנית (במקום לחכות ל-cron) — מהטרמינל:
   ```bash
   curl -X POST 'https://<REF>.supabase.co/functions/v1/send-reminders' \
     -H 'x-cron-secret: <CRON_SECRET>'
   ```
   תקבלו `{"ok":true,"enqueued":N,"sent":M}`.
3. ב-**Table Editor → notifications** תראו רשומת תזכורת. בכרטיס התור באתר (וטרינר)
   יופיע יומן "🔔 תזכורות".
4. אם מועד התזכורת כבר עבר (תור בעוד <24ש') — המייל יישלח. לחיצה על **ביטול התור**
   במייל → התור עובר ל-`cancelled` (בדקו באתר).

---

## מה הלאה

- **WhatsApp (שלב ב'):** ה-`sendNotification` כבר תומך בריבוי ערוצים — צריך ספק
  (Twilio / 360dialog / Green API) ואישור WhatsApp Business API. נחבר כשתחליטו על ספק.
- שאר ה-roadmap (קבצים בצ'אט, נקרא/לא-נקרא, חידוש מרשם, סיכום ביקור, טפסי הסכמה, AI).
