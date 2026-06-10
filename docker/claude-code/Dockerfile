FROM docker/sandbox-templates:claude-code

USER root
COPY shared/install-vibespace.sh /tmp/install-vibespace.sh
RUN chmod +x /tmp/install-vibespace.sh && /tmp/install-vibespace.sh

USER agent
RUN --mount=type=cache,target=/tmp/npm-cache,sharing=locked,mode=0777 \
    npm install -g @vibespace-ai/vibespace \
      --cache=/tmp/npm-cache \
      --fetch-retries=5 \
      --fetch-retry-mintimeout=20000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=600000 \
      --no-audit \
      --no-fund && \
    vibespace --version

COPY --chown=agent:agent shared/start-vibespace.sh /home/agent/.vibespace-start.sh
RUN echo '. ~/.vibespace-start.sh' >> /home/agent/.bashrc
