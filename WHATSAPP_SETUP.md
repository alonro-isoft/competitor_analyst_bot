# חיבור הבוט ל-WhatsApp

הפרויקט מחובר עכשיו ל-[OpenWA](https://github.com/rmyndharis/OpenWA) — שער WhatsApp API בקוד פתוח (לא רשמי, לא של Meta). הוא נוסף כ-git submodule בתיקייה `whatsapp-gateway/`. בנוסף נוסף שירות גישור קטן בתיקייה `whatsapp-bot/` שמקבל הודעות נכנסות מ-WhatsApp, מריץ אותן מול Gemini (אותה לוגיקת ניתוח מתחרים שיש ב-`competitor_analyst_bot.html`), ושולח בחזרה תשובה בטקסט.

## ⚠️ לפני שמתחילים

OpenWA מתחבר ל-WhatsApp דרך לקוחות לא-רשמיים (whatsapp-web.js / Baileys), לא דרך ה-Cloud API הרשמי של Meta. המשמעות:

- **יש סיכון אמיתי (לא אפסי) לחסימת המספר.** אל תחברו את המספר האישי/העסקי הראשי שלכם — השתמשו במספר ייעודי שאתם יכולים "להרשות לעצמכם לאבד".
- חמם מספר חדש בהדרגה (כמה ימים של שימוש אנושי רגיל) לפני שמתחילים לשלוח דרך הבוט.
- אל תשלחו הודעות יזומות בכמות גדולה לאנשים שלא כתבו לכם קודם.

לפרטים המלאים ראו את סעיף "Before you connect a number" ב-`whatsapp-gateway/README.md`.

## שלב 0: דרישות מוקדמות

- Docker + Docker Compose מותקנים במחשב/בשרת עליו תריצו את זה.
- מפתח Gemini API תקף (**לא** את המפתח שמופיע היום מוטמע בתוך `competitor_analyst_bot.html` — הוא חשוף בגיט ויש לבטל/להחליף אותו ב-Google AI Studio בהקדם).

## שלב 1: שיבוץ ה-submodule

```bash
git submodule update --init --recursive
```

## שלב 2: הרצת שער ה-WhatsApp (OpenWA)

```bash
cd whatsapp-gateway
docker compose -f docker-compose.dev.yml up -d --build
cd ..
```

זה מקים קונטיינר יחיד עם SQLite מקומי, ופותח:
- לוח בקרה: http://localhost:2785
- API: http://localhost:2785/api
- Swagger: http://localhost:2785/api/docs

בהרצה ראשונה נוצר מפתח API אדמין ראשוני. קראו אותו כך:

```bash
cat whatsapp-gateway/data/.api-key
```

שמרו את הערך — זה ה-`X-API-Key` שתשתמשו בו בשלבים הבאים.

## שלב 3: יצירת סשן WhatsApp וסריקת QR

```bash
API_KEY="<המפתח משלב 2>"

# יצירת סשן
curl -s -X POST http://localhost:2785/api/sessions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{"name": "competitor-bot"}'
# שימו לב ל-"id" שחוזר בתשובה — זה ה-sessionId

SESSION_ID="<המזהה מהתשובה למעלה>"

# הפעלת הסשן
curl -s -X POST "http://localhost:2785/api/sessions/$SESSION_ID/start" \
  -H "X-API-Key: $API_KEY"

# קבלת קוד QR (ניתן גם דרך לוח הבקרה http://localhost:2785)
curl -s "http://localhost:2785/api/sessions/$SESSION_ID/qr" \
  -H "X-API-Key: $API_KEY"
```

**כאן נדרשת פעולה מכם**: פתחו את WhatsApp בטלפון → הגדרות → מכשירים מקושרים → קישור מכשיר, וסרקו את קוד ה-QR (הכי נוח לעשות זאת דרך לוח הבקרה בדפדפן, שם ה-QR מוצג כתמונה). זו הפעולה היחידה שרק אתם יכולים לבצע — אין דרך לעקוף אותה.

לאחר הסריקה הסשן יעבור לסטטוס `ready`.

## שלב 4: הרצת שירות הגישור (whatsapp-bot)

```bash
cp whatsapp-bot/.env.example whatsapp-bot/.env
```

מלאו ב-`whatsapp-bot/.env`:
- `GEMINI_API_KEY` — מפתח Gemini תקף שלכם.
- `OPENWA_API_KEY` — אותו מפתח משלב 2 (מומלץ ליצור מפתח ייעודי בתפקיד OPERATOR דרך הדשבורד במקום להשתמש במפתח האדמין הראשוני).
- `OPENWA_SESSION_ID` — ה-sessionId משלב 3.
- `OPENWA_WEBHOOK_SECRET` — בחרו מחרוזת סודית אקראית (תשמש גם בשלב 5).

הרצה:

```bash
docker compose -f docker-compose.whatsapp-bot.yml up -d --build
```

## שלב 5: רישום ה-Webhook ב-OpenWA

```bash
curl -X POST "http://localhost:2785/api/sessions/$SESSION_ID/webhooks" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "url": "http://whatsapp-bot:3000/webhook",
    "events": ["message.received"],
    "secret": "<אותה מחרוזת שהזנתם ל-OPENWA_WEBHOOK_SECRET>"
  }'
```

שני הקונטיינרים (`openwa-api` ו-`whatsapp-bot`) יושבים על אותה רשת דוקר (`openwa-network`), ולכן הכתובת הפנימית `http://whatsapp-bot:3000/webhook` נגישה ישירות — אין צורך לחשוף אותה לאינטרנט כשמריצים הכל על אותה מכונה.

> אם מריצים את `whatsapp-bot` על שרת/מכונה אחרת, יש להחליף את ה-URL בכתובת נגישה מ-OpenWA, ולוודא ש-2785 ו/או 3000 חשופים בהתאם (ועדיף מאחורי HTTPS דרך reverse proxy — ראו `whatsapp-gateway/docs/12-troubleshooting-faq.md`).

## שלב 6: בדיקה

שלחו הודעת WhatsApp למספר שחיברתם, בפורמט:

```
שלי: Google Docs
מתחרה: Microsoft Word
שאלה: השוואת יכולות שיתוף קבצים ומחיר
```

אמורה לחזור תשובה עם סיכום, טבלת יכולות ויתרונות/חסרונות בפורמט טקסט מתאים ל-WhatsApp. הודעה שלא תואמת את הפורמט תקבל הודעת הסבר על השימוש.

## פתרון תקלות

- `docker compose -f whatsapp-gateway/docker-compose.dev.yml logs -f` — לוגים של השער.
- `docker compose -f docker-compose.whatsapp-bot.yml logs -f` — לוגים של הגישור (כולל שגיאות מ-Gemini או משליחה חזרה).
- טבלת דליברי כשלונות של ה-webhook: `GET /api/webhooks/delivery-failures` (דורש מפתח בתפקיד ADMIN).
- מדריך תקלות מלא: `whatsapp-gateway/docs/12-troubleshooting-faq.md`.
