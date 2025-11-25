ARG CRAWLEE_XVFB
ARG ACTOR_PATH_IN_DOCKER_CONTEXT

# Use headful Chrome image (Live View supported)
FROM apify/actor-node-puppeteer-chrome:22-24.12.1

# ... other steps (RUN node --version, COPY package*.json, RUN npm install)

# Set the environment variable for runtime
ENV CRAWLEE_XVFB=false

# Copy the rest of your source code
COPY --chown=myuser:myuser . ./

# Start actor (NO xvfb-run!)
CMD ["npm", "start"]