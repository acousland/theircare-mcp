FROM node:22-bookworm-slim
ENV NODE_ENV=production THEIRCARE_HOST=0.0.0.0 THEIRCARE_PORT=43817 THEIRCARE_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 43817
HEALTHCHECK --interval=30s --timeout=3s CMD ["node","-e","fetch('http://127.0.0.1:43817/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node","src/remote.js"]
