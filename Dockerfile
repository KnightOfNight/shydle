FROM alpine:3.20 AS builder

RUN apk add --no-cache git ca-certificates

ARG SHYDLE_REPO=https://github.com/KnightOfNight/shydle.git
ARG SHYDLE_REF=main

WORKDIR /src
RUN git clone --depth 1 --branch "${SHYDLE_REF}" "${SHYDLE_REPO}" shydle

FROM nginx:1.27-alpine

COPY --from=builder /src/shydle/index.html /usr/share/nginx/html/index.html
COPY --from=builder /src/shydle/script.js /usr/share/nginx/html/script.js
COPY --from=builder /src/shydle/styles.css /usr/share/nginx/html/styles.css
COPY --from=builder /src/shydle/words.json /usr/share/nginx/html/words.json

RUN chmod 0644 /usr/share/nginx/html/index.html \
  /usr/share/nginx/html/script.js \
  /usr/share/nginx/html/styles.css \
  /usr/share/nginx/html/words.json

EXPOSE 80
