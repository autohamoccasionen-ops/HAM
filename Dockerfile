FROM mcr.microsoft.com/playwright:v1.64.1-noble
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=pwuser:pwuser server.mjs quote.mjs browser-provider.mjs vehicle-services.mjs ./
USER pwuser
EXPOSE 10000
CMD ["node", "server.mjs"]
