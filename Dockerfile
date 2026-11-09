FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY static ./static
ENV NODE_ENV=production DB_PATH=/data/mess.db PORT=8000
VOLUME /data
EXPOSE 8000
CMD ["node", "server.js"]
