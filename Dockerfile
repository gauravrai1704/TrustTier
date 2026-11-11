# Reproduces every result of the TrustTier paper with nothing but Docker:
#   docker build -t trusttier .
#   docker run --rm trusttier                 # make reproduce (~5 min, 4 GB RAM)
#   docker run --rm trusttier make results-proving   # real-proof throughput benchmark
FROM node:20-bookworm-slim AS node

# Python 3.11 with venv, pip, git, make and compilers; Node 20 copied in.
FROM python:3.11-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version && npm --version

ENV DEBIAN_FRONTEND=noninteractive \
    HARDHAT_LOCAL_SOLC=1 \
    VENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH:/opt/tools/bin

# Optional: trust an extra CA (see docker/README.md).
COPY docker/ /tmp/docker/
RUN if [ -f /tmp/docker/extra-ca.crt ]; then \
      cp /tmp/docker/extra-ca.crt /usr/local/share/ca-certificates/extra-ca.crt && update-ca-certificates; \
    fi
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
    PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

# Echidna (property fuzzing), pinned.
RUN curl -sSL -o /tmp/echidna.tgz https://github.com/crytic/echidna/releases/download/v2.2.6/echidna-2.2.6-x86_64-linux.tar.gz \
    && tar -xzf /tmp/echidna.tgz -C /usr/local/bin echidna && rm /tmp/echidna.tgz

WORKDIR /trusttier

# Dependencies first, so code changes do not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY off-chain/requirements.txt off-chain/requirements.txt
COPY circuits/requirements.txt circuits/requirements.txt
RUN python3 -m venv $VENV && pip install --no-cache-dir -q --upgrade pip \
    && pip install --no-cache-dir -q -r off-chain/requirements.txt -r circuits/requirements.txt pytest
# Slither needs web3 7, the router web3 6: a separate venv for analysis tools.
RUN python3 -m venv /opt/tools && /opt/tools/bin/pip install --no-cache-dir -q slither-analyzer==0.11.6

COPY . .
# `make compare` diffs regenerated results against these committed ones.
RUN git init -q && git add -A && git -c user.name=build -c user.email=build@localhost commit -q -m snapshot \
    && npx hardhat compile

CMD ["make", "keys", "test", "analyze", "gas", "results", "compare", "VENV=/opt/venv", "TOOLS=/opt/tools"]
