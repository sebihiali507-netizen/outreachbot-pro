FROM ghcr.io/puppeteer/puppeteer:24.0.0

WORKDIR /app

COPY package*.json ./

RUN npm install --production --no-cache

COPY . .

ENV PORT=24771
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV NODE_ENV=production

RUN mkdir -p /app/data && chmod 777 /app/data

EXPOSE 24771

CMD ["node", "server.js"]
