# BookMyTicket

## Run Locally (Laptop)

```bash
cd /Users/premkumar/Desktop/tickets
npm install
npm run server
```

Open: `http://localhost:3000`

## Run on Wi-Fi (Other Laptop + Mobile)

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

## Public URL (Works Outside Wi-Fi)

Terminal 1:

```bash
npm run wifi
```

Terminal 2:

```bash
npm run public
```

`npm run public` creates a temporary Cloudflare URL you can share to any device/network.

## Google Login Setup

1. Google Cloud Console: create OAuth client.
2. Redirect URI: `http://localhost:3000/auth/google/callback`
3. In `.env` set:

```env
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
```
