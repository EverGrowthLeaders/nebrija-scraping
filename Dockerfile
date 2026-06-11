FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

ENV NODE_ENV=production

CMD ["node", "apps/api/src/server.mjs"]
