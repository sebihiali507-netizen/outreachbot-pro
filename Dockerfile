FROM ghcr.io/puppeteer/puppeteer:24.0.0

WORKDIR /app

# الانتقال لـ root لإعطاء الصلاحيات اللازمة
USER root

COPY package*.json ./

# إصلاح مشكلة الصلاحيات للمجلد بالكامل
RUN chown -R pptruser:pptruser /app

# العودة للمستخدم الآمن لتشغيل البوت
USER pptruser

RUN npm install

COPY --chown=pptruser:pptruser . .

ENV PORT=24771
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV NODE_ENV=production

EXPOSE 24771

CMD ["node", "server.js"]
