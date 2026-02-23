# BookMyTicket

Movie ticket booking MVP inspired by BookMyShow with:
- Google OAuth login hooks (plus demo login fallback)
- Current + upcoming movie browsing (Telugu/Hindi)
- Theater/showtime selection
- Live seat locking with Socket.IO
- Real-time seat availability sync
- Booking confirmation + payment receipt simulation
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
   npm start
   ```
4. Open [http://localhost:3000](http://localhost:3000)

## Google OAuth setup
To enable Google Sign-In, set in `.env`:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL` (must match configured OAuth redirect URI)

When OAuth is not configured, the app automatically provides a demo login prompt.

## Notes
- Seat locks expire automatically after `SEAT_LOCK_TTL_MS`.
- Seed data is added only on first run and stored in `bookmyticket.db`.
