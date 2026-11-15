FROM node:22-alpine
RUN apk add --no-cache unzip
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY admin ./admin
RUN mkdir -p /app/data/sites /app/data/tmp
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
