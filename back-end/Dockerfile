# syntax=docker/dockerfile:1

FROM node:24-alpine AS deps
WORKDIR /app/back-end
COPY back-end/package.json back-end/package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/back-end/node_modules ./back-end/node_modules
COPY back-end/package.json ./back-end/package.json
COPY back-end/src ./back-end/src
COPY front-end ./front-end

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "back-end/src/server.js"]
