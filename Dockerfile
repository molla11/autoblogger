FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN npm install -g pnpm@11.5.1
COPY . .
RUN pnpm install --frozen-lockfile

FROM base AS api
ENV NODE_ENV=production AUTH_MODE=supabase API_HOST=0.0.0.0
EXPOSE 4000
CMD ["pnpm", "--filter", "@autoblogger/api", "start"]

FROM api AS worker
CMD ["pnpm", "--filter", "@autoblogger/api", "worker"]

FROM base AS web-build
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
RUN pnpm --filter @autoblogger/web build
FROM web-build AS web
ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@autoblogger/web", "exec", "next", "start", "--hostname", "0.0.0.0"]
