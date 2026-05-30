# AmitVet production image — runs on Render, Railway, Fly.io, or any Docker host.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# App source
COPY . .

# Persist the SQLite database & JWT secret on a mounted volume at /data
ENV DATA_DIR=/data
VOLUME ["/data"]

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
