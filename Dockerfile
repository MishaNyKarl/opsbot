FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV DATA_FILE=/data/opsbot.json

RUN apk add --no-cache iputils

COPY package.json ./
COPY src ./src

RUN mkdir -p /data

VOLUME ["/data"]

CMD ["node", "src/index.js"]
