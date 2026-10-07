# OpenBots — Vercel Web + Persistent Runner

This version keeps the OpenBots dashboard on Vercel while the actual Discord bot processes run on a normal always-on Node.js server.

## 1. Deploy the website to Vercel

Upload the `vercel` folder to GitHub and import it into Vercel.
No Node server is required for the website.

## 2. Run the persistent runner

Use a VPS or another always-on Node.js machine. The runner needs Node.js 18+.

```bash
cd runner
npm install
```

Set these environment variables:

```text
OPENBOTS_TOKEN=YOUR_LONG_RANDOM_SECRET
CORS_ORIGIN=https://YOUR-OPENBOTS.vercel.app
```

Then:

```bash
npm start
```

The runner listens on `PORT` (default 3000).

For production, put it behind HTTPS (for example with Caddy/Nginx) and use a domain such as `https://runner.example.com`.

## 3. Connect the Vercel website

Open your Vercel site → **Runner Settings**.

Runner URL:
```text
https://runner.example.com
```

Runner Key:
```text
same value as OPENBOTS_TOKEN
```

Click **Test Connection**.

## 4. Use it

Drag/drop a complete bot folder into OpenBots.
Then use:

- Deploy → npm install + start
- Stop
- Restart
- .env editor
- Live logs

The Discord bot keeps running even when the Vercel browser tab is closed, because the runner process owns the bot process.

## Important

Vercel only hosts the dashboard. It is intentionally NOT used to run `child_process` Discord bots. The runner must be on a machine that stays online.

Do not expose the runner without `OPENBOTS_TOKEN`.
