# Deploying the phone app

The phone does not load the PWA from the desktop app. It loads it from
`https://mobile.accordagents.com/`, which is a Cloudflare Pages site. Merging a
change and restarting the desktop therefore does **not** put that change on the
phone — until this deploy runs, the phone keeps running whatever was published
last. This caught us on 2026-08-21: the `@`-mention picker and Stop-from-phone
were merged, built and running locally, and still absent on the phone a day
later.

## What it is

| | |
| --- | --- |
| Cloudflare account | `Julia.krivchikova@gmail.com's Account` (`72a0b869752e9838a0b5b21b2e4558b0`) |
| Pages project | `accordagents-mobile-control-staging` |
| Custom domain | `mobile.accordagents.com` |
| **Production branch** | **`staging`** — despite the project name, this is what the custom domain serves |
| Credentials | `CLOUDFLARE_API_TOKEN` in the environment; `npx wrangler whoami` confirms it |

The production branch being called `staging` is the trap here. Deploying to
`main` succeeds, prints a URL, looks entirely healthy — and changes nothing that
the phone can see, because that lands as a *preview* deployment.

## Deploying

```bash
npm run build:mobile                     # writes dist/mobile
npm run deploy:mobile                    # publishes it to the production branch
```

`npm run deploy:mobile` does not build. Build first, or you will publish the
previous bundle.

## Verifying, from the outside

Do not trust the deploy output. Ask the domain the phone actually uses:

```bash
curl -s https://mobile.accordagents.com/service-worker.js | grep ASSET_VERSION
curl -s https://mobile.accordagents.com/mobile-app.js | grep -c "<a string your change introduced>"
```

`ASSET_VERSION` in `src/mobile/service-worker.js` is what busts the phone's
cache. If a change ships without bumping it, the phone can keep serving its
cached copy: the service worker only refetches assets whose version string
changed. Bump it in the same commit as any change to `mobile-app.js`,
`mobile-app.css` or `index.html`.

## Which deployment is live

```bash
npx wrangler pages deployment list --project-name accordagents-mobile-control-staging
```

The `Environment` column says `Production` for the deployments the custom domain
serves. If the newest row is `Preview`, the phone is not running it.
