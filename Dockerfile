FROM apify/actor-node-playwright-vnc:20

ENV CRAWLEE_XVFB=false

COPY --chown=myuser:myuser package*.json ./
RUN npm install --omit=dev --omit=optional
COPY --chown=myuser:myuser . ./

CMD ["npm", "start"]
