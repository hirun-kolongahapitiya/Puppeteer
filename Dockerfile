FROM 031263542130.dkr.ecr.us-east-1.amazonaws.com/apify/actor-node-chrome-vnc:0.4

ENV CRAWLEE_XVFB=false
ENV APIFY_LIVE_VIEW_SERVER_PORT=4357

RUN node --version && npm --version

COPY --chown=myuser:myuser package*.json ./
RUN npm install --omit=dev --omit=optional

COPY --chown=myuser:myuser . ./

CMD ["npm", "start"]
