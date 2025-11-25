FROM apify/actor-node-puppeteer-vnc:22

ENV CRAWLEE_XVFB=false
ENV APIFY_LIVE_VIEW_SERVER_PORT=4357

# Show versions
RUN node --version && npm --version

# Copy package files
COPY --chown=myuser:myuser package*.json ./

# Install dependencies
RUN npm install --omit=dev --omit=optional

# Copy the rest of your source code
COPY --chown=myuser:myuser . ./

# Start actor (no xvfb-run!)
CMD ["npm", "start"]
