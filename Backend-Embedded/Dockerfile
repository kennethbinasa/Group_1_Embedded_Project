FROM node:20-alpine

WORKDIR /app

COPY . .
RUN cd Backend-Embedded && npm install --omit=dev

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "Backend-Embedded/server.js"]
