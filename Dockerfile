FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git cmake g++ make pkg-config libssl-dev zlib1g-dev ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/zhlynn/zsign.git /tmp/zsign && cmake -S /tmp/zsign -B /tmp/zsign/build -DCMAKE_BUILD_TYPE=Release && cmake --build /tmp/zsign/build --parallel 2 && find /tmp/zsign/build -type f -name zsign -perm -111 -exec install -m 0755 {} /usr/local/bin/zsign \; && test -x /usr/local/bin/zsign && rm -rf /tmp/zsign
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm","start"]
