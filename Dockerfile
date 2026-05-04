# استخدام نسخة Puppeteer الرسمية
FROM ghcr.io/puppeteer/puppeteer:24.0.0

# ضبط مجلد العمل
WORKDIR /app

# الانتقال لمستخدم root لضبط الصلاحيات (ضروري لحل خطأ EACCES)
USER root

# نسخ ملفات الحزم أولاً لضمان الكفاءة في البناء
COPY package*.json ./

# منح صلاحيات كاملة للمستخدم pptruser على مجلد العمل
RUN chown -R pptruser:pptruser /app

# العودة للمستخدم pptruser الآمن لتنفيذ العمليات التالية
USER pptruser

# تثبيت الحزم (تم استبدال --production بـ --omit=dev بناءً على تحذير npm)
RUN npm install --omit=dev

# نسخ بقية ملفات المشروع مع الحفاظ على ملكية المستخدم الصحيح
COPY --chown=pptruser:pptruser . .

# الإعدادات البيئية المطلوبة لتشغيل البوت
ENV PORT=24771
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV NODE_ENV=production

# فتح المنفذ
EXPOSE 24771

# تشغيل الخادم
CMD ["node", "server.js"]
