# BookMyTicket

## Local Run

```bash
cd /Users/premkumar/Desktop/tickets
npm install
npm run server
```

Open: `http://localhost:3000`

## Domain Run (`bookmyticket.local`)

```bash
cd /Users/premkumar/Desktop/tickets
npm run domain:start
```

Open: `http://bookmyticket.local`

## Wi-Fi Run (Laptop + Mobile on Same Network)

```bash
cd /Users/premkumar/Desktop/tickets
npm run wifi
```

This prints:
- Local URL
- Current Wi-Fi URL (LAN IP)
- Optional Bonjour URL (`http://<LocalHostName>.local:3000`)

Open the printed Wi-Fi URL on the other laptop/mobile.

## Use `bookmyticket.local` on Other Laptop

`bookmyticket.local` only works where hosts mapping exists.

1. Start server with `npm run wifi` and copy printed LAN IP.
2. On the other laptop, add hosts entry:

```bash
sudo sh -c 'echo "YOUR_LAN_IP bookmyticket.local" >> /etc/hosts'
```

3. Open: `http://bookmyticket.local:3000`

If Wi-Fi IP changes, update the hosts entry with the new IP.

## Free Source 1: Render (Permanent Public URL)

Use this for a stable free URL that works on laptop + mobile.

1. Push latest code to GitHub.
2. In Render, create Blueprint from this repo.
3. Blueprint path: `render.yaml`
4. Deploy branch: `main`

Render gives URL like: `https://<your-app>.onrender.com`

## Free Source 2: Public Tunnel (No account)

One command:

```bash
cd /Users/premkumar/Desktop/tickets
npm run public
```

This now:
- auto-starts server if needed
- tries Cloudflare first (`--retries=2`)
- auto-falls back to Serveo/LocalTunnel if Cloudflare is blocked

Keep terminal open while sharing the generated link.

If one provider is blocked on your network, force another:

```bash
TUNNEL_PROVIDER=localtunnel npm run public
```

```bash
TUNNEL_PROVIDER=serveo npm run public
```

## Google Login Setup

1. Google Cloud Console: create OAuth client.
2. Redirect URI: `http://localhost:3000/auth/google/callback`
3. In `.env` set:

```env
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
```
# BOOKMYTICKET.
