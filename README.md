# BookMyTicket

Movie ticket booking MVP inspired by BookMyShow with:
- Username + phone/password login/register with OTP verification
- Current + upcoming movie browsing (Telugu/Hindi)
- Auto-sliding featured movie hero carousel
- Theater/showtime selection
- Live seat locking with Socket.IO
- Real-time seat availability sync
- Real-time payment flow status in checkout
- Razorpay order + signature verification for UPI/Net Banking (when configured)
- Booking confirmation with QR ticket receipt
- Notifications for confirmations, reminders, and upcoming releases

## Tech stack
- Node.js + Express
- SQLite (persistent local database)
- Socket.IO (real-time seat lock state)
- Vanilla HTML/CSS/JS frontend

## Run locally
1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure environment:
   ```bash
   cp .env.example .env
   ```
3. Start the server:
   ```bash
   npm run server
   ```
4. Open [http://localhost:3000](http://localhost:3000)

## Open on mobile (same Wi-Fi)
1. Keep server running with `npm run server`.
2. Use your Mac LAN URL from terminal logs (example: `http://10.74.20.44:3000`).
3. Open that URL on your phone browser.

Notes:
- `localhost` works only on the same device, not on phone.
- `/etc/hosts` custom domains on Mac (like `bookmyticket.local`) do not resolve on phone unless configured there too.

## OTP setup (real SMS)
To send OTP in real time over SMS, set in `.env`:
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`

Without SMS config, OTP works in preview mode and shows demo OTP in UI.

## Razorpay setup (real UPI/Net Banking)
To enable live Razorpay checkout and server-side verification, set in `.env`:
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`

Without Razorpay keys, the app uses a real-time simulated payment status flow for UPI/Net Banking.

## Email receipt setup
To send ticket receipt email after booking, set in `.env`:
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM_EMAIL`
- `SMTP_FROM_NAME`

## Notes
- Seat locks expire automatically after `SEAT_LOCK_TTL_MS`.
- Shows auto-refresh in a rolling window (`SHOW_WINDOW_DAYS`) so date/time stays current every day.
- Seed data is added only on first run and stored in `bookmyticket.db`.
