FROM node:20.20.0-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DB_PATH=/tmp/bookmyticket.db

EXPOSE 3000

CMD ["node", "server/index.js"]
