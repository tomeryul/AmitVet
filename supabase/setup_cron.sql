-- ============================================================================
-- AmitVet · חיווט תזכורות אוטומטיות עם pg_cron + pg_net
-- הריצו ב-Supabase → SQL Editor *אחרי* שפרסתם את ה-Edge Function send-reminders
-- והגדרתם את ה-secret שלה. החליפו את שני ה-placeholders למטה.
--
--   <PROJECT_REF>  — מזהה הפרויקט (מתוך כתובת ה-Supabase: https://<REF>.supabase.co)
--   <CRON_SECRET>  — אותה מחרוזת סודית שהגדרתם כ-secret בשם CRON_SECRET לפונקציה
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- הסרת תזמון קודם (אם קיים) — מאפשר הרצה חוזרת בטוחה.
select cron.unschedule('amitvet-send-reminders')
where exists (select 1 from cron.job where jobname = 'amitvet-send-reminders');

-- כל 15 דקות: קריאה ל-Edge Function שמתזמנת ושולחת תזכורות שהגיע מועדן.
select cron.schedule(
  'amitvet-send-reminders',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', '<CRON_SECRET>'
               ),
    body    := '{}'::jsonb
  );
  $$
);

-- לבדיקה: רשימת ה-jobs המתוזמנים
-- select * from cron.job;
