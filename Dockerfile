FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends gocryptfs fuse3 ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && echo "user_allow_other" >> /etc/fuse.conf
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY app ./app
COPY public ./public
ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["node", "app/server.js"]
