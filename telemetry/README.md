# Telemetry collector

A Cloudflare Worker that receives anvesa's anonymous telemetry batches and forwards them to
PostHog. What the CLI sends, and when, is described in the main README under *Telemetry*.

```
anvesa CLI ──POST batch──▶ this worker ──/batch/──▶ PostHog (EU)
                           checks every field
                           reads no IP or header
```

Why a worker in between, and not PostHog directly:

- **No client address reaches the store.** The worker never reads the request's address or
  headers, and PostHog only ever sees Cloudflare's address. Events are also marked
  `$process_person_profile: false` (no person profiles) and `$geoip_disable: true`.
- **Allowlist.** Every field is checked against a fixed list. Strings must be short tokens and
  numbers small, and unknown event types are dropped. A modified client can't store prose, paths
  or names. See `EVENT_FIELDS` in `src/worker.ts`.
- **Swappable.** The CLI only knows this URL, so the store can change without a release.

## Deploy

1. Create a PostHog project in the EU cloud. In its settings, turn on *Discard client IP data*
   as a second guard.
2. Deploy from this directory:

   ```bash
   bunx wrangler@4 secret put POSTHOG_KEY
   ```

   ```bash
   bunx wrangler@4 deploy
   ```

3. Set `DEFAULT_TELEMETRY_ENDPOINT` in `cli/src/telemetry.ts` to the URL wrangler prints (or the
   custom domain in `wrangler.toml`), and release. Until then the CLI has no default endpoint and
   sends nothing.

To try it before a release, run `ANVESA_TELEMETRY_ENDPOINT=<url> anvesa telemetry on` and then
run commands.

## Questions the data answers

Events reach PostHog as `anvesa_<type>`. With HogQL:

```sql
-- Does the ranker change what is shown first, and how far does it reach?
select properties.modelId, avg(toInt(properties.topChanged)), avg(properties.overlapAt10),
       quantile(0.9)(properties.topFirstRank)
from events where event = 'anvesa_rank' and properties.reranked
group by 1

-- Where does the hub step stop being cheap?
select properties.nodeCountBucket as cards, properties.durationMsBucket as hub, count()
from events where event = 'anvesa_index' and properties.name = 'hub'
group by 1, 2 order by 1, 2
```

Tests: `bun test telemetry/`.
