FROM rust:1.86-bookworm AS builder

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src

RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates sqlite3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/snake

COPY --from=builder /app/target/release/snake-game-backend /usr/local/bin/snake-game-backend
COPY migrations ./migrations

ENV PORT=8787
EXPOSE 8787

CMD ["snake-game-backend"]
