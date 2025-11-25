# Use headful Chrome image (Live View supported)
FROM apify/actor-node-puppeteer-chrome:22-24.12.1

# Show versions
RUN node --version && npm --version

# Copy package files first (build caching)
COPY --chown=myuser:myuser package*.json ./

# Install dependencies (production only)
RUN npm install --omit=dev --omit=optional

# Copy the rest of your source code
COPY --chown=myuser:myuser . ./

# Start actor (NO xvfb-run!)
CMD ["npm", "start"]