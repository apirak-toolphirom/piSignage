FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
ENV PORT=3000 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
