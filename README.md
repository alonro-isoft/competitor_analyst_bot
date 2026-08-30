# בוט לניתוח מתחרים

- `competitor_analyst_bot.html` — אפליקציית דף-יחיד (Tailwind + Gemini API) שמריצה השוואת מתחרים דרך דפדפן.
- `whatsapp-gateway/` — [OpenWA](https://github.com/rmyndharis/OpenWA), שער WhatsApp API בקוד פתוח (git submodule), שמאפשר לשלוח/לקבל הודעות WhatsApp.
- `whatsapp-bot/` — שירות גישור: מקבל הודעות נכנסות מ-OpenWA, מריץ את אותה לוגיקת ניתוח מתחרים מול Gemini בצד שרת, ומחזיר תשובה ל-WhatsApp.

להוראות התקנה מלאות לחיבור הבוט ל-WhatsApp (כולל סריקת קוד ה-QR) ראו **[WHATSAPP_SETUP.md](./WHATSAPP_SETUP.md)**.

## ⚠️ אזהרת אבטחה

הקובץ `competitor_analyst_bot.html` מכיל כרגע מפתח Gemini API מוטמע ישירות בקוד הצד-לקוח, וזה חשוף בהיסטוריית הגיט. יש **לבטל/להחליף את המפתח הזה ב-Google AI Studio** ולא להשתמש בו שוב. השירות החדש (`whatsapp-bot/`) מקבל את המפתח כמשתנה סביבה בצד שרת בלבד ואינו חושף אותו ללקוח.
