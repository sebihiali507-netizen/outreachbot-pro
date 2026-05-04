# استخدام نسخة Puppeteer الرسمية
FROM ghcr.io/puppeteer/puppeteer:24.0.0

# ضبط مجلد العمل
WORKDIR /app

# الانتقال لـ root لفرض الصلاحيات
USER root

# حذف أي ملفات قديمة قد تسبب تضارب في الصلاحيات
RUN rm -rf /app/*

# نسخ ملفات الحزم فقط في البداية
COPY package*.json ./

# منح الملكية الكاملة للمستخدم pptruser قبل التثبيت
RUN chown -R pptruser:pptruser /app

# العودة للمستخدم الآمن
USER pptruser

# تثبيت الحزم (باستخدام الممارسات الموصى بها في السجلات)
RUN npm install --omit=dev

# نسخ بقية الملفات مع التأكد من الملكية
COPY --chown=pptruser:pptruser . .

# الإعدادات البيئية
ENV PORT=24771
ENV NODE_ENV=production

EXPOSE 24771

CMD ["node", "server.js"]
