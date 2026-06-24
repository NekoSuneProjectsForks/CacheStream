# OAuth2 relay — tiny, dependency-free Node service.
FROM node:20-alpine
WORKDIR /app
# No third-party deps: copy package manifest + source only.
COPY package.json ./
COPY src ./src
COPY client ./client
ENV NODE_ENV=production
EXPOSE 8788
# Run as the built-in non-root user.
USER node
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
