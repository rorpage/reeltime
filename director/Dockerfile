FROM node:22-alpine
WORKDIR /app
COPY director/package.json ./
RUN npm install --omit=dev
COPY src/utils.js ./src/utils.js
COPY director/src/ ./director/src/
EXPOSE 10000
CMD ["node", "director/src/director.js"]
