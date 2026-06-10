FROM docker/sandbox-templates:codex

USER root
COPY shared/install-vibespace.sh /tmp/install-vibespace.sh
RUN chmod +x /tmp/install-vibespace.sh && /tmp/install-vibespace.sh

USER agent
RUN npm install -g @vibespace-ai/vibespace && vibespace --version

COPY --chown=agent:agent shared/start-vibespace.sh /home/agent/.vibespace-start.sh
RUN echo '. ~/.vibespace-start.sh' >> /home/agent/.bashrc
