FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# The official Node images already ship a non-root "node" user (uid 1000) -
# use it instead of running as root, standard practice for a public image.
RUN chown -R node:node /app
USER node
EXPOSE 4000
# No curl/wget in the slim base image - Node's own http module does the
# check instead. Uses the real GET /health endpoint (public, no auth,
# exists specifically for this).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||4000)+'/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.js"]
