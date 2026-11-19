FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git g++ make pkg-config libssl-dev ca-certificates unzip libplist-utils \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/zhlynn/zsign.git /tmp/zsign \
    && make -C /tmp/zsign/build/linux -j2 \
    && install -m 0755 /tmp/zsign/bin/zsign /usr/local/bin/zsign \
    && /usr/local/bin/zsign --version \
    && rm -rf /tmp/zsign

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
