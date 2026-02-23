const crypto = require('crypto');
const http = require('http');
const path = require('path');

const cors = require('cors');
const dotenv = require('dotenv');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const QRCode = require('qrcode');
const sqlite3 = require('sqlite3').verbose();
const { Server } = require('socket.io');

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || 'bookmyticket-dev-secret';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL =
  process.env.GOOGLE_CALLBACK_URL || `http://localhost:${PORT}/auth/google/callback`;
const LOCK_TTL_MS = Number(process.env.SEAT_LOCK_TTL_MS || 120000);
const DB_PATH = path.join(__dirname, '..', 'bookmyticket.db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
const db = new sqlite3.Database(DB_PATH);

db.configure('busyTimeout', 5000);

const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });

const get = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });

const all = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });

const placeholders = (length) => Array.from({ length }, () => '?').join(',');

const GOOGLE_ENABLED = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

function sanitizeUser(user) {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatar_url,
  };
}

async function upsertOAuthUser(profile) {
  const email = profile.emails?.[0]?.value?.toLowerCase() || null;
  const name = profile.displayName || email || 'Movie User';
  const avatarUrl = profile.photos?.[0]?.value || null;

  const found = await get(
    `SELECT id FROM users WHERE google_sub = ? OR email = ? LIMIT 1`,
    [profile.id, email]
  );

  if (found) {
    await run(
      `UPDATE users
       SET name = ?,
           email = COALESCE(?, email),
           google_sub = ?,
           avatar_url = ?
       WHERE id = ?`,
      [name, email, profile.id, avatarUrl, found.id]
    );
    return get(`SELECT * FROM users WHERE id = ?`, [found.id]);
  }

  const inserted = await run(
    `INSERT INTO users (name, email, google_sub, avatar_url)
     VALUES (?, ?, ?, ?)`,
    [name, email, profile.id, avatarUrl]
  );

  return get(`SELECT * FROM users WHERE id = ?`, [inserted.lastID]);
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await get(`SELECT * FROM users WHERE id = ?`, [id]);
    done(null, user || false);
  } catch (error) {
    done(error);
  }
});

if (GOOGLE_ENABLED) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: GOOGLE_CALLBACK_URL,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const user = await upsertOAuthUser(profile);
          done(null, user);
        } catch (error) {
          done(error);
        }
      }
    )
  );
}

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

async function initializeSchema() {
  await run(`PRAGMA foreign_keys = ON`);

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      google_sub TEXT UNIQUE,
      avatar_url TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS movies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      language TEXT NOT NULL,
      status TEXT NOT NULL,
      genre TEXT NOT NULL,
      duration_min INTEGER NOT NULL,
      rating REAL NOT NULL,
      description TEXT NOT NULL,
      poster_url TEXT,
      banner_url TEXT,
      trailer_url TEXT,
      release_date TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS theaters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      location TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS screens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      theater_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      seat_rows INTEGER NOT NULL,
      seat_cols INTEGER NOT NULL,
      FOREIGN KEY(theater_id) REFERENCES theaters(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS shows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movie_id INTEGER NOT NULL,
      theater_id INTEGER NOT NULL,
      screen_id INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      price REAL NOT NULL,
      FOREIGN KEY(movie_id) REFERENCES movies(id) ON DELETE CASCADE,
      FOREIGN KEY(theater_id) REFERENCES theaters(id) ON DELETE CASCADE,
      FOREIGN KEY(screen_id) REFERENCES screens(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS show_seats (
      show_id INTEGER NOT NULL,
      seat_label TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'available',
      locked_by TEXT,
      lock_until INTEGER,
      booking_id INTEGER,
      PRIMARY KEY (show_id, seat_label),
      FOREIGN KEY(show_id) REFERENCES shows(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      show_id INTEGER NOT NULL,
      payment_ref TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      total_amount REAL NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(show_id) REFERENCES shows(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS booking_seats (
      booking_id INTEGER NOT NULL,
      seat_label TEXT NOT NULL,
      PRIMARY KEY (booking_id, seat_label),
      FOREIGN KEY(booking_id) REFERENCES bookings(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
}

function titleToSlug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function seedMovies() {
  const movies = [
    {
      title: 'Pushpa 2: The Rule',
      language: 'Telugu',
      status: 'now_showing',
      genre: 'Action, Drama, Thriller',
      durationMin: 184,
      rating: 8.8,
      description:
        'Pushpa Raj continues his rise in the red sandalwood world while new rivals challenge his empire.',
      posterUrl: 'https://upload.wikimedia.org/wikipedia/en/1/11/Pushpa_2-_The_Rule.jpg',
      bannerUrl: 'https://upload.wikimedia.org/wikipedia/en/1/11/Pushpa_2-_The_Rule.jpg',
      trailerUrl: 'https://www.youtube.com/results?search_query=Pushpa+2+Trailer',
      releaseDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 50).toISOString(),
    },
    {
      title: 'Kalki 2898 AD',
      language: 'Telugu',
      status: 'now_showing',
      genre: 'Sci-Fi, Action',
      durationMin: 176,
      rating: 8.5,
      description: 'A dystopian battle between destiny and rebellion in a mythological sci-fi world.',
      posterUrl: 'https://upload.wikimedia.org/wikipedia/en/4/4c/Kalki_2898_AD.jpg',
      bannerUrl: 'https://upload.wikimedia.org/wikipedia/en/4/4c/Kalki_2898_AD.jpg',
      trailerUrl: 'https://www.youtube.com/results?search_query=Kalki+2898+AD+Trailer',
      releaseDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 120).toISOString(),
    },
    {
      title: 'Stree 2',
      language: 'Hindi',
      status: 'now_showing',
      genre: 'Comedy, Horror',
      durationMin: 147,
      rating: 8.1,
      description: 'A spooky town reunion where old legends return with unexpected twists.',
      posterUrl: 'https://upload.wikimedia.org/wikipedia/en/a/a1/Stree_2.jpg',
      bannerUrl: 'https://upload.wikimedia.org/wikipedia/en/a/a1/Stree_2.jpg',
      trailerUrl: 'https://www.youtube.com/results?search_query=Stree+2+Trailer',
      releaseDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 80).toISOString(),
    },
    {
      title: 'Devara: Part 1',
      aliases: ['Devara Part 1'],
      language: 'Telugu',
      status: 'upcoming',
      genre: 'Action, Epic',
      durationMin: 165,
      rating: 8.2,
      description: 'A coastal war drama of power, loyalty, and legacy.',
      posterUrl: 'https://upload.wikimedia.org/wikipedia/en/f/f0/Devara_Part_1.jpg',
      bannerUrl: 'https://upload.wikimedia.org/wikipedia/en/f/f0/Devara_Part_1.jpg',
      trailerUrl: 'https://www.youtube.com/results?search_query=Devara+Trailer',
      releaseDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString(),
    },
    {
      title: 'Lucky Baskhar',
      language: 'Telugu',
      status: 'upcoming',
      genre: 'Crime, Drama',
      durationMin: 152,
      rating: 7.9,
      description: 'A middle-class banker is pulled into a dangerous money trail.',
      posterUrl: 'https://upload.wikimedia.org/wikipedia/en/6/6c/Lucky_Baskhar_film_poster.jpg',
      bannerUrl: 'https://upload.wikimedia.org/wikipedia/en/6/6c/Lucky_Baskhar_film_poster.jpg',
      trailerUrl: 'https://www.youtube.com/results?search_query=Lucky+Baskhar+Trailer',
      releaseDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 28).toISOString(),
    },
    {
      title: 'Singham Again',
      language: 'Hindi',
      status: 'upcoming',
      genre: 'Action, Cop Drama',
      durationMin: 160,
      rating: 8.0,
      description: 'A high-voltage police action film with interconnected franchise characters.',
      posterUrl: 'https://upload.wikimedia.org/wikipedia/en/0/04/Singham_Again_poster.jpg',
      bannerUrl: 'https://upload.wikimedia.org/wikipedia/en/0/04/Singham_Again_poster.jpg',
      trailerUrl: 'https://www.youtube.com/results?search_query=Singham+Again+Trailer',
      releaseDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 10).toISOString(),
    },
    {
      title: 'Chhaava',
      language: 'Hindi',
      status: 'upcoming',
      genre: 'Historical, Drama',
      durationMin: 170,
      rating: 7.8,
      description: 'A period epic centered on courage, leadership, and sacrifice.',
      posterUrl: 'https://upload.wikimedia.org/wikipedia/en/7/75/Chhaava_film_poster.jpg',
      bannerUrl: 'https://upload.wikimedia.org/wikipedia/en/7/75/Chhaava_film_poster.jpg',
      trailerUrl: 'https://www.youtube.com/results?search_query=Chhaava+Trailer',
      releaseDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 24).toISOString(),
    },
    {
      title: 'Toxic',
      aliases: ['Toxic (2026 film)', 'Toxic: A Fairy Tale for Grown-Ups'],
      language: 'Hindi',
      status: 'upcoming',
      genre: 'Action, Thriller',
      durationMin: 158,
      rating: 8.4,
      description: 'A stylized crime-action tale led by Yash in a dark underworld setting.',
      posterUrl: 'https://upload.wikimedia.org/wikipedia/en/0/0b/Toxic-_A_Fairy_Tale_for_Grown-Ups_poster.jpg',
      bannerUrl: 'https://upload.wikimedia.org/wikipedia/en/0/0b/Toxic-_A_Fairy_Tale_for_Grown-Ups_poster.jpg',
      trailerUrl: 'https://www.youtube.com/results?search_query=Toxic+Yash+Trailer',
      releaseDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 18).toISOString(),
    },
  ];

  for (const movie of movies) {
    const lookupTitles = [movie.title, ...(movie.aliases || [])];
    const existing = await get(
      `SELECT id FROM movies WHERE title IN (${placeholders(lookupTitles.length)}) LIMIT 1`,
      lookupTitles
    );

    if (existing) {
      await run(
        `UPDATE movies
         SET title = ?,
             language = ?,
             status = ?,
             genre = ?,
             duration_min = ?,
             rating = ?,
             description = ?,
             poster_url = ?,
             banner_url = ?,
             trailer_url = ?,
             release_date = ?
         WHERE id = ?`,
        [
          movie.title,
          movie.language,
          movie.status,
          movie.genre,
          movie.durationMin,
          movie.rating,
          movie.description,
          movie.posterUrl,
          movie.bannerUrl,
          movie.trailerUrl,
          movie.releaseDate,
          existing.id,
        ]
      );
    } else {
      await run(
        `INSERT INTO movies (
          title, language, status, genre, duration_min, rating, description, poster_url,
          banner_url, trailer_url, release_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          movie.title,
          movie.language,
          movie.status,
          movie.genre,
          movie.durationMin,
          movie.rating,
          movie.description,
          movie.posterUrl,
          movie.bannerUrl,
          movie.trailerUrl,
          movie.releaseDate,
        ]
      );
    }
  }
}

async function seedTheatersAndScreens() {
  const theaterCount = await get(`SELECT COUNT(*) AS count FROM theaters`);
  if (theaterCount.count > 0) {
    return;
  }

  const theaterSeeds = [
    { name: 'Galaxy Cinemas', location: 'Vaghodia' },
    { name: 'Royal Multiplex', location: 'Alkapuri' },
    { name: 'Silver Screens', location: 'Manjalpur' },
  ];

  const screenTemplates = [
    { name: 'Screen 1', rows: 8, cols: 12 },
    { name: 'Screen 2', rows: 10, cols: 14 },
  ];

  for (const theater of theaterSeeds) {
    const created = await run(
      `INSERT INTO theaters (name, location) VALUES (?, ?)`,
      [theater.name, theater.location]
    );

    for (const screen of screenTemplates) {
      await run(
        `INSERT INTO screens (theater_id, name, seat_rows, seat_cols)
         VALUES (?, ?, ?, ?)`,
        [created.lastID, screen.name, screen.rows, screen.cols]
      );
    }
  }
}

function buildSeatLabels(rowCount, colCount) {
  const labels = [];
  for (let row = 0; row < rowCount; row += 1) {
    const rowChar = String.fromCharCode(65 + row);
    for (let col = 1; col <= colCount; col += 1) {
      labels.push(`${rowChar}${col}`);
    }
  }
  return labels;
}

async function seedShowsAndSeats() {
  const showCount = await get(`SELECT COUNT(*) AS count FROM shows`);
  if (showCount.count > 0) {
    return;
  }

  const nowShowingMovies = await all(
    `SELECT id FROM movies WHERE status = 'now_showing' ORDER BY rating DESC`
  );
  const screens = await all(`SELECT id, theater_id, seat_rows, seat_cols FROM screens ORDER BY id ASC`);
  const hourSlots = [11, 14, 17, 20, 22];

  for (let dayOffset = 0; dayOffset < 4; dayOffset += 1) {
    for (let movieIndex = 0; movieIndex < nowShowingMovies.length; movieIndex += 1) {
      const movie = nowShowingMovies[movieIndex];

      for (let screenIndex = 0; screenIndex < screens.length; screenIndex += 1) {
        const screen = screens[screenIndex];
        const start = new Date();
        start.setDate(start.getDate() + dayOffset);
        start.setHours(hourSlots[(movieIndex + screenIndex + dayOffset) % hourSlots.length], 0, 0, 0);

        const ticketPrice = 180 + ((movieIndex + screenIndex) % 3) * 40;

        const show = await run(
          `INSERT INTO shows (movie_id, theater_id, screen_id, start_time, price)
           VALUES (?, ?, ?, ?, ?)`,
          [movie.id, screen.theater_id, screen.id, start.toISOString(), ticketPrice]
        );

        const seatLabels = buildSeatLabels(screen.seat_rows, screen.seat_cols);
        for (const seatLabel of seatLabels) {
          await run(
            `INSERT INTO show_seats (show_id, seat_label, state) VALUES (?, ?, 'available')`,
            [show.lastID, seatLabel]
          );
        }
      }
    }
  }
}

async function cleanupExpiredLocks(showId = null) {
  const now = Date.now();
  if (showId !== null) {
    await run(
      `UPDATE show_seats
       SET state = 'available', locked_by = NULL, lock_until = NULL
       WHERE show_id = ? AND state = 'locked' AND lock_until <= ?`,
      [showId, now]
    );
    return;
  }

  await run(
    `UPDATE show_seats
     SET state = 'available', locked_by = NULL, lock_until = NULL
     WHERE state = 'locked' AND lock_until <= ?`,
    [now]
  );
}

async function getSeatSnapshot(showId) {
  await cleanupExpiredLocks(showId);

  const seats = await all(
    `SELECT
      seat_label AS seatLabel,
      state,
      locked_by AS lockedBy,
      lock_until AS lockUntil
     FROM show_seats
     WHERE show_id = ?
     ORDER BY seat_label ASC`,
    [showId]
  );

  return seats;
}

async function lockSeats({ showId, seatLabels, lockerToken }) {
  if (!seatLabels.length) {
    return;
  }

  await run(`BEGIN IMMEDIATE TRANSACTION`);
  try {
    await cleanupExpiredLocks(showId);
    const seats = await all(
      `SELECT seat_label, state, locked_by, lock_until
       FROM show_seats
       WHERE show_id = ? AND seat_label IN (${placeholders(seatLabels.length)})`,
      [showId, ...seatLabels]
    );

    if (seats.length !== seatLabels.length) {
      throw new Error('One or more selected seats do not exist.');
    }

    const now = Date.now();
    const conflict = seats.find(
      (seat) =>
        seat.state === 'booked' ||
        (seat.state === 'locked' && seat.locked_by !== lockerToken && seat.lock_until > now)
    );

    if (conflict) {
      throw new Error(`Seat ${conflict.seat_label} is unavailable.`);
    }

    await run(
      `UPDATE show_seats
       SET state = 'locked', locked_by = ?, lock_until = ?
       WHERE show_id = ? AND seat_label IN (${placeholders(seatLabels.length)})`,
      [lockerToken, now + LOCK_TTL_MS, showId, ...seatLabels]
    );

    await run(`COMMIT`);
  } catch (error) {
    await run(`ROLLBACK`);
    throw error;
  }
}

async function releaseSeats({ showId, seatLabels, lockerToken }) {
  if (!seatLabels.length) {
    return;
  }

  await run(
    `UPDATE show_seats
     SET state = 'available', locked_by = NULL, lock_until = NULL
     WHERE show_id = ?
       AND locked_by = ?
       AND state = 'locked'
       AND seat_label IN (${placeholders(seatLabels.length)})`,
    [showId, lockerToken, ...seatLabels]
  );
}

async function createBooking({ showId, seatLabels, lockerToken, userId, paymentMethod }) {
  if (!seatLabels.length) {
    throw new Error('Select at least one seat.');
  }

  await run(`BEGIN IMMEDIATE TRANSACTION`);

  try {
    await cleanupExpiredLocks(showId);
    const showMeta = await get(
      `SELECT
        s.id,
        s.price,
        s.start_time AS startTime,
        m.title AS movieTitle,
        m.language AS movieLanguage,
        t.name AS theaterName,
        t.location AS theaterLocation,
        sc.name AS screenName
       FROM shows s
       INNER JOIN movies m ON m.id = s.movie_id
       INNER JOIN theaters t ON t.id = s.theater_id
       INNER JOIN screens sc ON sc.id = s.screen_id
       WHERE s.id = ?`,
      [showId]
    );

    if (!showMeta) {
      throw new Error('Show not found.');
    }

    const seats = await all(
      `SELECT seat_label, state, locked_by, lock_until
       FROM show_seats
       WHERE show_id = ? AND seat_label IN (${placeholders(seatLabels.length)})`,
      [showId, ...seatLabels]
    );

    if (seats.length !== seatLabels.length) {
      throw new Error('Some seats are invalid for this show.');
    }

    const now = Date.now();
    const notOwned = seats.find(
      (seat) =>
        seat.state !== 'locked' ||
        seat.locked_by !== lockerToken ||
        typeof seat.lock_until !== 'number' ||
        seat.lock_until <= now
    );

    if (notOwned) {
      throw new Error(`Seat ${notOwned.seat_label} is no longer locked by you.`);
    }

    const totalAmount = Number((showMeta.price * seatLabels.length).toFixed(2));
    const paymentRef = `PAY-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const booking = await run(
      `INSERT INTO bookings (user_id, show_id, payment_ref, payment_method, total_amount, status)
       VALUES (?, ?, ?, ?, ?, 'confirmed')`,
      [userId || null, showId, paymentRef, paymentMethod, totalAmount]
    );

    for (const seatLabel of seatLabels) {
      await run(
        `INSERT INTO booking_seats (booking_id, seat_label) VALUES (?, ?)`,
        [booking.lastID, seatLabel]
      );
    }

    await run(
      `UPDATE show_seats
       SET state = 'booked', locked_by = NULL, lock_until = NULL, booking_id = ?
       WHERE show_id = ? AND seat_label IN (${placeholders(seatLabels.length)})`,
      [booking.lastID, showId, ...seatLabels]
    );

    if (userId) {
      const reminderTime = new Date(showMeta.startTime).toLocaleString();
      await run(
        `INSERT INTO notifications (user_id, type, title, message)
         VALUES (?, 'booking', 'Booking Confirmed', ?)`,
        [
          userId,
          `Booking #${booking.lastID} confirmed for ${showMeta.movieTitle}. Seats: ${seatLabels.join(', ')}.`,
        ]
      );
      await run(
        `INSERT INTO notifications (user_id, type, title, message)
         VALUES (?, 'payment', 'Payment Receipt', ?)`,
        [
          userId,
          `Payment ${paymentRef} successful. Amount paid: INR ${totalAmount.toFixed(2)}.`,
        ]
      );
      await run(
        `INSERT INTO notifications (user_id, type, title, message)
         VALUES (?, 'reminder', 'Show Reminder Scheduled', ?)`,
        [
          userId,
          `Reminder set for ${showMeta.movieTitle} at ${reminderTime}.`,
        ]
      );
    }

    await run(`COMMIT`);

    const qrGeneratedAt = new Date().toISOString();
    const qrPayload = JSON.stringify({
      bookingId: booking.lastID,
      movie: showMeta.movieTitle,
      theater: showMeta.theaterName,
      showtime: showMeta.startTime,
      seats: seatLabels,
      paymentRef,
      paymentMethod,
      generatedAt: qrGeneratedAt,
    });
    let qrCodeDataUrl = null;
    try {
      qrCodeDataUrl = await QRCode.toDataURL(qrPayload, {
        margin: 1,
        width: 220,
        color: {
          dark: '#000000',
          light: '#FFFFFF',
        },
      });
    } catch (_error) {
      qrCodeDataUrl = null;
    }

    return {
      bookingId: booking.lastID,
      paymentRef,
      paymentMethod,
      totalAmount,
      seats: seatLabels,
      show: showMeta,
      qrCodeDataUrl,
      qrGeneratedAt,
      receiptSlug: titleToSlug(showMeta.movieTitle),
    };
  } catch (error) {
    await run(`ROLLBACK`);
    throw error;
  }
}

async function initializeData() {
  await initializeSchema();
  await seedMovies();
  await seedTheatersAndScreens();
  await seedShowsAndSeats();
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'bookmyticket' });
});

app.get('/api/auth/session', (req, res) => {
  res.json({
    authenticated: Boolean(req.user),
    user: sanitizeUser(req.user),
    googleEnabled: GOOGLE_ENABLED,
  });
});

app.post('/api/auth/dev-login', async (req, res) => {
  const name = (req.body?.name || '').trim();
  const email = (req.body?.email || '').trim().toLowerCase();

  if (!name) {
    res.status(400).json({ error: 'Name is required for demo login.' });
    return;
  }

  const safeEmail = email || `${titleToSlug(name)}@demo.local`;

  try {
    const existing = await get(`SELECT * FROM users WHERE email = ?`, [safeEmail]);

    let user = existing;
    if (!existing) {
      const inserted = await run(
        `INSERT INTO users (name, email) VALUES (?, ?)`,
        [name, safeEmail]
      );
      user = await get(`SELECT * FROM users WHERE id = ?`, [inserted.lastID]);
    } else if (existing.name !== name) {
      await run(`UPDATE users SET name = ? WHERE id = ?`, [name, existing.id]);
      user = await get(`SELECT * FROM users WHERE id = ?`, [existing.id]);
    }

    req.login(user, (error) => {
      if (error) {
        res.status(500).json({ error: 'Failed to create session.' });
        return;
      }

      res.json({ ok: true, user: sanitizeUser(user), googleEnabled: GOOGLE_ENABLED });
    });
  } catch (error) {
    res.status(500).json({ error: 'Unable to login with demo user.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.logout(() => {
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ ok: true });
    });
  });
});

app.get('/auth/google', (req, res, next) => {
  if (!GOOGLE_ENABLED) {
    res.status(503).json({ error: 'Google OAuth is not configured on this server.' });
    return;
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/auth/google/callback', (req, res, next) => {
  if (!GOOGLE_ENABLED) {
    res.redirect('/?auth=unavailable');
    return;
  }

  passport.authenticate('google', { failureRedirect: '/?auth=failed' })(req, res, () => {
    res.redirect('/?auth=success');
  });
});

app.get('/api/home', async (_req, res) => {
  try {
    const nowShowing = await all(
      `SELECT * FROM movies
       WHERE status = 'now_showing'
       ORDER BY rating DESC, title ASC`
    );

    const upcomingTelugu = await all(
      `SELECT * FROM movies
       WHERE status = 'upcoming' AND language = 'Telugu'
       ORDER BY release_date ASC`
    );

    const upcomingHindi = await all(
      `SELECT * FROM movies
       WHERE status = 'upcoming' AND language = 'Hindi'
       ORDER BY release_date ASC`
    );

    const featured = nowShowing[0] || null;

    res.json({
      featured,
      nowShowing,
      upcomingTelugu,
      upcomingHindi,
    });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load home data.' });
  }
});

app.get('/api/movies', async (req, res) => {
  const conditions = [];
  const params = [];

  if (req.query.status) {
    conditions.push('status = ?');
    params.push(req.query.status);
  }
  if (req.query.language) {
    conditions.push('language = ?');
    params.push(req.query.language);
  }
  if (req.query.search) {
    conditions.push('LOWER(title) LIKE ?');
    params.push(`%${String(req.query.search).toLowerCase()}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const rows = await all(
      `SELECT * FROM movies ${where} ORDER BY status ASC, rating DESC, release_date ASC`,
      params
    );
    res.json({ movies: rows });
  } catch (error) {
    res.status(500).json({ error: 'Unable to fetch movies.' });
  }
});

app.get('/api/movies/:movieId/shows', async (req, res) => {
  try {
    const shows = await all(
      `SELECT
        s.id,
        s.start_time AS startTime,
        s.price,
        t.name AS theaterName,
        t.location AS theaterLocation,
        sc.name AS screenName,
        sc.seat_rows AS seatRows,
        sc.seat_cols AS seatCols
       FROM shows s
       INNER JOIN theaters t ON t.id = s.theater_id
       INNER JOIN screens sc ON sc.id = s.screen_id
       WHERE s.movie_id = ?
         AND datetime(s.start_time) >= datetime('now', '-2 hours')
       ORDER BY s.start_time ASC`,
      [req.params.movieId]
    );

    res.json({ shows });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load showtimes.' });
  }
});

app.get('/api/shows/:showId/seats', async (req, res) => {
  try {
    const show = await get(
      `SELECT
        s.id,
        s.start_time AS startTime,
        s.price,
        m.title AS movieTitle,
        t.name AS theaterName,
        sc.name AS screenName,
        sc.seat_rows AS seatRows,
        sc.seat_cols AS seatCols
       FROM shows s
       INNER JOIN movies m ON m.id = s.movie_id
       INNER JOIN theaters t ON t.id = s.theater_id
       INNER JOIN screens sc ON sc.id = s.screen_id
       WHERE s.id = ?`,
      [req.params.showId]
    );

    if (!show) {
      res.status(404).json({ error: 'Show not found.' });
      return;
    }

    const seats = await getSeatSnapshot(Number(req.params.showId));
    res.json({ show, seats, lockTtlMs: LOCK_TTL_MS });
  } catch (error) {
    res.status(500).json({ error: 'Unable to fetch seat map.' });
  }
});

app.post('/api/bookings/confirm', async (req, res) => {
  const showId = Number(req.body?.showId);
  const paymentMethodRaw = String(req.body?.paymentMethod || 'UPI')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
  const allowedMethods = new Set(['UPI', 'CRYPTO', 'NET_BANKING']);
  const paymentMethod = allowedMethods.has(paymentMethodRaw) ? paymentMethodRaw : null;
  const seatLabels = Array.isArray(req.body?.seatLabels)
    ? req.body.seatLabels.map((label) => String(label).trim().toUpperCase()).filter(Boolean)
    : [];
  const lockerToken = String(req.body?.lockerToken || '').trim();

  if (!showId || !seatLabels.length || !lockerToken) {
    res.status(400).json({ error: 'showId, seatLabels and lockerToken are required.' });
    return;
  }

  if (!paymentMethod) {
    res.status(400).json({ error: 'paymentMethod must be one of UPI, CRYPTO, NET_BANKING.' });
    return;
  }

  try {
    const booking = await createBooking({
      showId,
      seatLabels,
      lockerToken,
      userId: req.user?.id,
      paymentMethod,
    });

    const seats = await getSeatSnapshot(showId);
    io.to(`show:${showId}`).emit('seats_update', { showId, seats, lockTtlMs: LOCK_TTL_MS });

    res.json({ ok: true, booking });
  } catch (error) {
    res.status(409).json({ error: error.message || 'Booking failed.' });
  }
});

app.get('/api/notifications', async (req, res) => {
  try {
    const upcomingAlerts = await all(
      `SELECT id, title, language, release_date AS releaseDate
       FROM movies
       WHERE status = 'upcoming'
       ORDER BY release_date ASC
       LIMIT 4`
    );

    if (!req.user) {
      res.json({
        notifications: upcomingAlerts.map((movie) => ({
          id: `upcoming-${movie.id}`,
          type: 'upcoming',
          title: 'Upcoming Movie Alert',
          message: `${movie.title} (${movie.language}) releases on ${new Date(movie.releaseDate).toLocaleDateString()}.`,
          createdAt: movie.releaseDate,
        })),
      });
      return;
    }

    const persistent = await all(
      `SELECT
        id,
        type,
        title,
        message,
        created_at AS createdAt
       FROM notifications
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 20`,
      [req.user.id]
    );

    const reminders = await all(
      `SELECT
        b.id AS bookingId,
        m.title AS movieTitle,
        s.start_time AS startTime
       FROM bookings b
       INNER JOIN shows s ON s.id = b.show_id
       INNER JOIN movies m ON m.id = s.movie_id
       WHERE b.user_id = ?
         AND datetime(s.start_time) >= datetime('now')
         AND datetime(s.start_time) <= datetime('now', '+12 hours')
       ORDER BY s.start_time ASC`,
      [req.user.id]
    );

    const reminderNotifications = reminders.map((item) => ({
      id: `reminder-${item.bookingId}`,
      type: 'reminder',
      title: 'Show Reminder',
      message: `${item.movieTitle} starts at ${new Date(item.startTime).toLocaleString()}.`,
      createdAt: item.startTime,
    }));

    const upcomingNotifications = upcomingAlerts.map((movie) => ({
      id: `upcoming-${movie.id}`,
      type: 'upcoming',
      title: 'Upcoming Movie Alert',
      message: `${movie.title} (${movie.language}) releases on ${new Date(movie.releaseDate).toLocaleDateString()}.`,
      createdAt: movie.releaseDate,
    }));

    res.json({ notifications: [...reminderNotifications, ...persistent, ...upcomingNotifications] });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load notifications.' });
  }
});

io.on('connection', (socket) => {
  socket.on('join_show', async (payload = {}) => {
    const showId = Number(payload.showId);
    if (!showId) {
      return;
    }

    socket.join(`show:${showId}`);

    try {
      const seats = await getSeatSnapshot(showId);
      socket.emit('seats_update', { showId, seats, lockTtlMs: LOCK_TTL_MS });
    } catch (_error) {
      socket.emit('server_error', { message: 'Unable to load seats.' });
    }
  });

  socket.on('lock_seats', async (payload = {}, ack = () => {}) => {
    const showId = Number(payload.showId);
    const lockerToken = String(payload.lockerToken || '').trim();
    const seatLabels = Array.isArray(payload.seatLabels)
      ? payload.seatLabels.map((label) => String(label).trim().toUpperCase()).filter(Boolean)
      : [];

    if (!showId || !lockerToken || seatLabels.length === 0) {
      ack({ ok: false, error: 'showId, lockerToken and seatLabels are required.' });
      return;
    }

    try {
      await lockSeats({ showId, seatLabels, lockerToken });
      const seats = await getSeatSnapshot(showId);
      io.to(`show:${showId}`).emit('seats_update', { showId, seats, lockTtlMs: LOCK_TTL_MS });
      ack({ ok: true });
    } catch (error) {
      ack({ ok: false, error: error.message || 'Unable to lock seats.' });
    }
  });

  socket.on('release_seats', async (payload = {}, ack = () => {}) => {
    const showId = Number(payload.showId);
    const lockerToken = String(payload.lockerToken || '').trim();
    const seatLabels = Array.isArray(payload.seatLabels)
      ? payload.seatLabels.map((label) => String(label).trim().toUpperCase()).filter(Boolean)
      : [];

    if (!showId || !lockerToken || seatLabels.length === 0) {
      ack({ ok: false, error: 'showId, lockerToken and seatLabels are required.' });
      return;
    }

    try {
      await releaseSeats({ showId, seatLabels, lockerToken });
      const seats = await getSeatSnapshot(showId);
      io.to(`show:${showId}`).emit('seats_update', { showId, seats, lockTtlMs: LOCK_TTL_MS });
      ack({ ok: true });
    } catch (error) {
      ack({ ok: false, error: 'Unable to release seats.' });
    }
  });
});

setInterval(async () => {
  try {
    const rows = await all(
      `SELECT DISTINCT show_id AS showId
       FROM show_seats
       WHERE state = 'locked' AND lock_until <= ?`,
      [Date.now()]
    );

    if (rows.length === 0) {
      return;
    }

    await cleanupExpiredLocks();

    for (const row of rows) {
      const seats = await getSeatSnapshot(row.showId);
      io.to(`show:${row.showId}`).emit('seats_update', {
        showId: row.showId,
        seats,
        lockTtlMs: LOCK_TTL_MS,
      });
    }
  } catch (_error) {
    // Periodic cleanup errors should not stop the server.
  }
}, 5000);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

async function bootstrap() {
  await initializeData();
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`BookMyTicket listening on http://localhost:${PORT}`);
  });
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', error);
  process.exit(1);
});
