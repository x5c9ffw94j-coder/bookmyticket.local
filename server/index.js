const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');

const cors = require('cors');
const dotenv = require('dotenv');
const express = require('express');
const session = require('express-session');
const nodemailer = require('nodemailer');
const passport = require('passport');
const QRCode = require('qrcode');
const Razorpay = require('razorpay');
const sqlite3 = require('sqlite3').verbose();
const { Server } = require('socket.io');

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_SECRET = process.env.SESSION_SECRET || 'bookmyticket-dev-secret';
const LOCK_TTL_MS = Number(process.env.SEAT_LOCK_TTL_MS || 120000);
const SHOW_WINDOW_DAYS = Number(process.env.SHOW_WINDOW_DAYS || 5);
const OTP_TTL_MS = Number(process.env.OTP_TTL_MS || 3 * 60 * 1000);
const OTP_RESEND_MS = Number(process.env.OTP_RESEND_MS || 30 * 1000);
const OTP_DEFAULT_COUNTRY_CODE = String(process.env.OTP_DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, '') || '91';
const OTP_DEBUG_PREVIEW =
  String(process.env.OTP_DEBUG_PREVIEW || '').toLowerCase() === 'true' ||
  process.env.NODE_ENV !== 'production';
const OTP_REQUIRE_SMS = String(process.env.OTP_REQUIRE_SMS || '').toLowerCase() === 'true';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';
const OTP_SMS_ENABLED = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER);
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const SMTP_HOST = (process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM_EMAIL = (process.env.SMTP_FROM_EMAIL || '').trim();
const SMTP_FROM_NAME = (process.env.SMTP_FROM_NAME || 'BookMyTicket').trim();
const EMAIL_DELIVERY_REQUIRED = String(process.env.EMAIL_DELIVERY_REQUIRED || '').toLowerCase() === 'true';
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
const ALLOWED_PAYMENT_METHODS = new Set(['UPI', 'CRYPTO', 'NET_BANKING']);

const RAZORPAY_ENABLED = Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
const razorpay = RAZORPAY_ENABLED
  ? new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET,
    })
  : null;
const SMTP_ENABLED = Boolean(SMTP_HOST && SMTP_PORT && SMTP_FROM_EMAIL);
const mailTransport = SMTP_ENABLED
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
    })
  : null;

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

function normalizePhone(phoneInput) {
  const phone = String(phoneInput || '').replace(/\D/g, '').trim();
  if (phone.length < 10 || phone.length > 15) {
    return null;
  }
  return phone;
}

function normalizeEmailAddress(emailInput) {
  const email = String(emailInput || '').trim().toLowerCase();
  if (!email) {
    return null;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }
  return email;
}

function maskEmail(emailInput) {
  const email = String(emailInput || '').trim();
  const atIndex = email.indexOf('@');
  if (atIndex < 2) {
    return email;
  }
  const username = email.slice(0, atIndex);
  const domain = email.slice(atIndex);
  return `${username.slice(0, 2)}${'*'.repeat(Math.max(username.length - 2, 1))}${domain}`;
}

function emitRealtimeNotification(userId, notification) {
  if (!userId || !notification) {
    return;
  }
  io.to(`user:${userId}`).emit('notification', { notification });
}

async function insertUserNotification({ userId, type, title, message }) {
  const created = await run(
    `INSERT INTO notifications (user_id, type, title, message)
     VALUES (?, ?, ?, ?)`,
    [userId, type, title, message]
  );

  return {
    id: created.lastID,
    type,
    title,
    message,
    createdAt: new Date().toISOString(),
  };
}

async function sendBookingReceiptEmail({ toEmail, toName, booking }) {
  if (!toEmail) {
    return { sent: false, reason: 'missing_email' };
  }
  if (!mailTransport || !SMTP_ENABLED) {
    return { sent: false, reason: 'not_configured' };
  }

  const subject = `BookMyTicket Receipt #${booking.bookingId}`;
  const showTime = new Date(booking.show.startTime).toLocaleString();
  const seats = booking.seats.join(', ');

  const text = [
    `Hi ${toName || 'Movie Lover'},`,
    '',
    'Your booking is confirmed.',
    `Booking ID: ${booking.bookingId}`,
    `Movie: ${booking.show.movieTitle}`,
    `Theater: ${booking.show.theaterName} (${booking.show.screenName})`,
    `Show Time: ${showTime}`,
    `Seats: ${seats}`,
    `Payment Method: ${booking.paymentMethod}`,
    `Payment Ref: ${booking.paymentRef}`,
    `Amount Paid: INR ${Number(booking.totalAmount).toFixed(2)}`,
    '',
    'Thanks for booking with BookMyTicket.',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;color:#101828;">
      <h2 style="margin-bottom:8px;">Booking Confirmed</h2>
      <p style="margin-top:0;">Hi ${toName || 'Movie Lover'}, your ticket is confirmed.</p>
      <table style="border-collapse:collapse;width:100%;max-width:560px;">
        <tr><td style="padding:6px 0;">Booking ID</td><td style="padding:6px 0;"><strong>${
          booking.bookingId
        }</strong></td></tr>
        <tr><td style="padding:6px 0;">Movie</td><td style="padding:6px 0;">${booking.show.movieTitle}</td></tr>
        <tr><td style="padding:6px 0;">Theater</td><td style="padding:6px 0;">${booking.show.theaterName} (${
          booking.show.screenName
        })</td></tr>
        <tr><td style="padding:6px 0;">Show Time</td><td style="padding:6px 0;">${showTime}</td></tr>
        <tr><td style="padding:6px 0;">Seats</td><td style="padding:6px 0;">${seats}</td></tr>
        <tr><td style="padding:6px 0;">Payment</td><td style="padding:6px 0;">${booking.paymentMethod} · ${
          booking.paymentRef
        }</td></tr>
        <tr><td style="padding:6px 0;">Amount</td><td style="padding:6px 0;"><strong>INR ${Number(
          booking.totalAmount
        ).toFixed(2)}</strong></td></tr>
      </table>
    </div>
  `;

  try {
    await mailTransport.sendMail({
      from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_EMAIL}>`,
      to: toEmail,
      subject,
      text,
      html,
    });

    return { sent: true };
  } catch (error) {
    if (EMAIL_DELIVERY_REQUIRED) {
      throw error;
    }
    return { sent: false, reason: error.message || 'send_failed' };
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${digest}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }

  const [, salt, expectedHex] = parts;
  const actualHex = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  if (expected.length !== actual.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, actual);
}

function generateOtpCode() {
  return `${Math.floor(100000 + Math.random() * 900000)}`;
}

function toE164Phone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return null;
  }
  if (normalized.length === 10) {
    return `+${OTP_DEFAULT_COUNTRY_CODE}${normalized}`;
  }
  return `+${normalized}`;
}

function maskPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return '';
  }
  if (normalized.length <= 4) {
    return normalized;
  }
  return `${'*'.repeat(Math.max(0, normalized.length - 4))}${normalized.slice(-4)}`;
}

function buildOtpMessage(otpCode) {
  const minutes = Math.max(1, Math.round(OTP_TTL_MS / 60000));
  return `BookMyTicket OTP: ${otpCode}. Valid for ${minutes} minutes.`;
}

async function sendOtpViaTwilio(phone, otpCode) {
  const toPhone = toE164Phone(phone);
  if (!toPhone) {
    throw new Error('Invalid phone for OTP SMS delivery.');
  }

  const body = new URLSearchParams({
    To: toPhone,
    From: TWILIO_FROM_NUMBER,
    Body: buildOtpMessage(otpCode),
  });

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    }
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.message || payload.error_message || `HTTP ${response.status}`;
    throw new Error(`SMS provider failed: ${message}`);
  }

  return {
    channel: 'sms',
    provider: 'twilio',
    sid: payload.sid || null,
  };
}

async function sendOtpRealtime(phone, otpCode) {
  if (!OTP_SMS_ENABLED) {
    return {
      channel: 'preview',
      provider: 'local',
      sent: true,
      maskedPhone: maskPhone(phone),
      otpPreview: OTP_DEBUG_PREVIEW ? otpCode : null,
    };
  }

  try {
    const sms = await sendOtpViaTwilio(phone, otpCode);
    return {
      channel: sms.channel,
      provider: sms.provider,
      sent: true,
      maskedPhone: maskPhone(phone),
      sid: sms.sid,
      otpPreview: OTP_DEBUG_PREVIEW ? otpCode : null,
    };
  } catch (error) {
    if (OTP_REQUIRE_SMS) {
      throw error;
    }
    return {
      channel: 'preview',
      provider: 'fallback',
      sent: true,
      maskedPhone: maskPhone(phone),
      otpPreview: OTP_DEBUG_PREVIEW ? otpCode : null,
      warning: error.message,
    };
  }
}

async function ensureUserAuthColumns() {
  const columns = await all(`PRAGMA table_info(users)`);
  const columnNames = new Set(columns.map((column) => column.name));

  const additions = [
    ['phone', 'TEXT'],
    ['password_hash', 'TEXT'],
    ['otp_code', 'TEXT'],
    ['otp_expires_at', 'INTEGER'],
    ['otp_last_sent_at', 'INTEGER'],
    ['otp_purpose', 'TEXT'],
    ['otp_verified_at', 'TEXT'],
  ];

  for (const [name, type] of additions) {
    if (!columnNames.has(name)) {
      await run(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
    }
  }

  await run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique
    ON users(phone)
    WHERE phone IS NOT NULL
  `);
}

async function issueOtpForUser(userId, purpose) {
  const user = await get(`SELECT id, phone, otp_last_sent_at, otp_purpose FROM users WHERE id = ?`, [userId]);
  if (!user) {
    throw new Error('User not found.');
  }
  if (!user.phone) {
    throw new Error('Phone number missing for OTP delivery.');
  }

  const now = Date.now();
  if (
    Number(user.otp_last_sent_at) &&
    now - Number(user.otp_last_sent_at) < OTP_RESEND_MS &&
    String(user.otp_purpose || '') === purpose
  ) {
    const waitSeconds = Math.ceil((OTP_RESEND_MS - (now - Number(user.otp_last_sent_at))) / 1000);
    throw new Error(`Please wait ${waitSeconds}s before requesting another OTP.`);
  }

  const otpCode = generateOtpCode();
  const expiresAt = now + OTP_TTL_MS;

  await run(
    `UPDATE users
     SET otp_code = ?, otp_expires_at = ?, otp_last_sent_at = ?, otp_purpose = ?
     WHERE id = ?`,
    [otpCode, expiresAt, now, purpose, userId]
  );

  const delivery = await sendOtpRealtime(user.phone, otpCode);
  return {
    otpCode,
    expiresAt,
    delivery,
  };
}

async function verifyOtpForPhone({ phone, otp, purpose }) {
  const user = await get(`SELECT * FROM users WHERE phone = ?`, [phone]);
  if (!user) {
    throw new Error('Account not found for this phone number.');
  }

  const now = Date.now();
  const validPurpose = String(user.otp_purpose || '');
  const validCode = String(user.otp_code || '');
  const expiresAt = Number(user.otp_expires_at || 0);

  if (!validCode || !expiresAt || expiresAt < now) {
    throw new Error('OTP expired. Request a new OTP.');
  }
  if (validPurpose !== purpose) {
    throw new Error('OTP purpose mismatch. Start login again.');
  }
  if (validCode !== String(otp || '').trim()) {
    throw new Error('Invalid OTP.');
  }

  await run(
    `UPDATE users
     SET otp_code = NULL,
         otp_expires_at = NULL,
         otp_purpose = NULL,
         otp_verified_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [user.id]
  );

  return get(`SELECT * FROM users WHERE id = ?`, [user.id]);
}

function loginWithSession(req, user) {
  return new Promise((resolve, reject) => {
    req.login(user, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
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

function requireAuth(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: 'Login required to book tickets.' });
    return;
  }
  next();
}

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});
io.use((socket, next) => {
  passport.initialize()(socket.request, {}, next);
});
io.use((socket, next) => {
  passport.session()(socket.request, {}, next);
});

async function initializeSchema() {
  await run(`PRAGMA foreign_keys = ON`);

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      phone TEXT,
      password_hash TEXT,
      google_sub TEXT UNIQUE,
      avatar_url TEXT,
      otp_code TEXT,
      otp_expires_at INTEGER,
      otp_last_sent_at INTEGER,
      otp_purpose TEXT,
      otp_verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureUserAuthColumns();

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
      title: 'Leo',
      aliases: ['Leo (2023 Indian film)'],
      language: 'Tamil',
      status: 'now_showing',
      genre: 'Action, Thriller',
      durationMin: 164,
      rating: 8.2,
      description: 'A cafe owner in a mountain town gets dragged into a violent underworld.',
      posterUrl: 'https://upload.wikimedia.org/wikipedia/en/7/75/Leo_%282023_Indian_film%29.jpg',
      bannerUrl: 'https://upload.wikimedia.org/wikipedia/en/7/75/Leo_%282023_Indian_film%29.jpg',
      trailerUrl: 'https://www.youtube.com/results?search_query=Leo+Tamil+Trailer',
      releaseDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 95).toISOString(),
    },
    {
      title: 'Manjummel Boys',
      language: 'Malayalam',
      status: 'now_showing',
      genre: 'Adventure, Thriller',
      durationMin: 134,
      rating: 8.3,
      description: 'A true-story inspired survival drama set around a dangerous cave rescue.',
      posterUrl: 'https://upload.wikimedia.org/wikipedia/en/9/99/Manjummel_Boys_poster.jpg',
      bannerUrl: 'https://upload.wikimedia.org/wikipedia/en/9/99/Manjummel_Boys_poster.jpg',
      trailerUrl: 'https://www.youtube.com/results?search_query=Manjummel+Boys+Trailer',
      releaseDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString(),
    },
    {
      title: 'Premalu',
      language: 'Malayalam',
      status: 'now_showing',
      genre: 'Romance, Comedy',
      durationMin: 156,
      rating: 8.0,
      description: 'A light-hearted love story set between Hyderabad dreams and campus chaos.',
      posterUrl: 'https://upload.wikimedia.org/wikipedia/en/c/c5/Premalu_film_poster.jpg',
      bannerUrl: 'https://upload.wikimedia.org/wikipedia/en/c/c5/Premalu_film_poster.jpg',
      trailerUrl: 'https://www.youtube.com/results?search_query=Premalu+Trailer',
      releaseDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 42).toISOString(),
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
    {
      title: 'Coolie',
      aliases: ['Coolie (2025 film)'],
      language: 'Tamil',
      status: 'upcoming',
      genre: 'Action, Drama',
      durationMin: 168,
      rating: 8.1,
      description: 'A high-stakes action drama headlined by Rajinikanth with Lokesh universe buzz.',
      posterUrl: 'https://upload.wikimedia.org/wikipedia/en/a/a8/Coolie_%282025_film%29_poster.jpg',
      bannerUrl: 'https://upload.wikimedia.org/wikipedia/en/a/a8/Coolie_%282025_film%29_poster.jpg',
      trailerUrl: 'https://www.youtube.com/results?search_query=Coolie+Rajinikanth+Trailer',
      releaseDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 12).toISOString(),
    },
    {
      title: 'Thug Life',
      aliases: ['Thug Life (2025 film)'],
      language: 'Tamil',
      status: 'upcoming',
      genre: 'Action, Crime',
      durationMin: 170,
      rating: 8.2,
      description: 'Kamal Haasan and Mani Ratnam reunite for a gritty large-scale gangster drama.',
      posterUrl: 'https://upload.wikimedia.org/wikipedia/en/9/95/Thug_Life_2025.jpg',
      bannerUrl: 'https://upload.wikimedia.org/wikipedia/en/9/95/Thug_Life_2025.jpg',
      trailerUrl: 'https://www.youtube.com/results?search_query=Thug+Life+Kamal+Trailer',
      releaseDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 22).toISOString(),
    },
    {
      title: 'L2: Empuraan',
      aliases: ['L2 Empuraan'],
      language: 'Malayalam',
      status: 'upcoming',
      genre: 'Action, Political Thriller',
      durationMin: 170,
      rating: 8.4,
      description: 'The next chapter in the Lucifer universe with a global-scale political action plot.',
      posterUrl: 'https://upload.wikimedia.org/wikipedia/en/3/35/L2_-_Empuraan_poster.jpg',
      bannerUrl: 'https://upload.wikimedia.org/wikipedia/en/3/35/L2_-_Empuraan_poster.jpg',
      trailerUrl: 'https://www.youtube.com/results?search_query=L2+Empuraan+Trailer',
      releaseDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 16).toISOString(),
    },
    {
      title: 'Bazooka',
      aliases: ['Bazooka (film)'],
      language: 'Malayalam',
      status: 'upcoming',
      genre: 'Action, Thriller',
      durationMin: 154,
      rating: 7.9,
      description: 'A stylish thriller centered on strategy, risk, and a high-profile lead performance.',
      posterUrl: 'https://upload.wikimedia.org/wikipedia/en/a/a9/Bazooka_poster.jpeg',
      bannerUrl: 'https://upload.wikimedia.org/wikipedia/en/a/a9/Bazooka_poster.jpeg',
      trailerUrl: 'https://www.youtube.com/results?search_query=Bazooka+Malayalam+Trailer',
      releaseDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
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
  await run(`
    DELETE FROM shows
    WHERE id IN (
      SELECT s.id
      FROM shows s
      LEFT JOIN bookings b ON b.show_id = s.id
      WHERE datetime(s.start_time) < datetime('now', '-1 day')
      GROUP BY s.id
      HAVING COUNT(b.id) = 0
    )
  `);

  const nowShowingMovies = await all(
    `SELECT id FROM movies WHERE status = 'now_showing' ORDER BY rating DESC`
  );
  const screens = await all(`SELECT id, theater_id, seat_rows, seat_cols FROM screens ORDER BY id ASC`);
  if (!nowShowingMovies.length || !screens.length) {
    return;
  }

  const hourSlots = [11, 14, 17, 20, 22];
  const base = new Date();
  base.setMinutes(0, 0, 0);

  for (let dayOffset = 0; dayOffset < SHOW_WINDOW_DAYS; dayOffset += 1) {
    for (let movieIndex = 0; movieIndex < nowShowingMovies.length; movieIndex += 1) {
      const movie = nowShowingMovies[movieIndex];

      for (let screenIndex = 0; screenIndex < screens.length; screenIndex += 1) {
        const screen = screens[screenIndex];
        const start = new Date(base);
        start.setDate(base.getDate() + dayOffset);
        start.setHours(hourSlots[(movieIndex + screenIndex + dayOffset) % hourSlots.length], 0, 0, 0);
        const startIso = start.toISOString();

        const existingShow = await get(
          `SELECT id FROM shows WHERE movie_id = ? AND screen_id = ? AND start_time = ? LIMIT 1`,
          [movie.id, screen.id, startIso]
        );

        if (existingShow) {
          continue;
        }

        const ticketPrice = 180 + ((movieIndex + screenIndex) % 3) * 40;
        const createdShow = await run(
          `INSERT INTO shows (movie_id, theater_id, screen_id, start_time, price)
           VALUES (?, ?, ?, ?, ?)`,
          [movie.id, screen.theater_id, screen.id, startIso, ticketPrice]
        );

        const seatLabels = buildSeatLabels(screen.seat_rows, screen.seat_cols);
        for (const seatLabel of seatLabels) {
          await run(
            `INSERT INTO show_seats (show_id, seat_label, state) VALUES (?, ?, 'available')`,
            [createdShow.lastID, seatLabel]
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

async function getPaymentScope({ showId, seatLabels, lockerToken }) {
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

  return {
    showMeta,
    totalAmount: Number((showMeta.price * seatLabels.length).toFixed(2)),
  };
}

async function createBooking({
  showId,
  seatLabels,
  lockerToken,
  userId,
  paymentMethod,
  paymentRefOverride = null,
}) {
  if (!seatLabels.length) {
    throw new Error('Select at least one seat.');
  }

  const normalizedUserId = Number(userId || 0) || null;
  const realtimeNotifications = [];
  let bookingUser = null;
  let inTransaction = false;

  await run(`BEGIN IMMEDIATE TRANSACTION`);
  inTransaction = true;

  try {
    const { showMeta, totalAmount } = await getPaymentScope({ showId, seatLabels, lockerToken });
    const paymentRef =
      paymentRefOverride || `PAY-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    if (normalizedUserId) {
      bookingUser = await get(`SELECT id, name, email FROM users WHERE id = ?`, [normalizedUserId]);
    }

    const booking = await run(
      `INSERT INTO bookings (user_id, show_id, payment_ref, payment_method, total_amount, status)
       VALUES (?, ?, ?, ?, ?, 'confirmed')`,
      [normalizedUserId, showId, paymentRef, paymentMethod, totalAmount]
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

    if (normalizedUserId) {
      const reminderTime = new Date(showMeta.startTime).toLocaleString();
      realtimeNotifications.push(
        await insertUserNotification({
          userId: normalizedUserId,
          type: 'booking',
          title: 'Booking Confirmed',
          message: `Booking #${booking.lastID} confirmed for ${showMeta.movieTitle}. Seats: ${seatLabels.join(', ')}.`,
        })
      );
      realtimeNotifications.push(
        await insertUserNotification({
          userId: normalizedUserId,
          type: 'payment',
          title: 'Payment Receipt',
          message: `Payment ${paymentRef} successful. Amount paid: INR ${totalAmount.toFixed(2)}.`,
        })
      );
      realtimeNotifications.push(
        await insertUserNotification({
          userId: normalizedUserId,
          type: 'reminder',
          title: 'Show Reminder Scheduled',
          message: `Reminder set for ${showMeta.movieTitle} at ${reminderTime}.`,
        })
      );
    }

    await run(`COMMIT`);
    inTransaction = false;

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

    const bookingPayload = {
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

    if (normalizedUserId && realtimeNotifications.length) {
      for (const notification of realtimeNotifications) {
        emitRealtimeNotification(normalizedUserId, notification);
      }
    }

    if (normalizedUserId && bookingUser?.email) {
      try {
        const emailResult = await sendBookingReceiptEmail({
          toEmail: bookingUser.email,
          toName: bookingUser.name,
          booking: bookingPayload,
        });

        if (emailResult.sent) {
          const emailNotification = await insertUserNotification({
            userId: normalizedUserId,
            type: 'email',
            title: 'Email Receipt Sent',
            message: `Ticket receipt sent to ${maskEmail(bookingUser.email)}.`,
          });
          emitRealtimeNotification(normalizedUserId, emailNotification);
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Email receipt delivery failed:', error.message || error);
      }
    }

    return bookingPayload;
  } catch (error) {
    if (inTransaction) {
      await run(`ROLLBACK`);
    }
    throw error;
  }
}

async function initializeData() {
  await initializeSchema();
  await seedMovies();
  await seedTheatersAndScreens();
  await seedShowsAndSeats();
}

function getLanIpv4Addresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const entries of Object.values(interfaces)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (!entry || entry.family !== 'IPv4' || entry.internal) {
        continue;
      }
      addresses.push(entry.address);
    }
  }

  return Array.from(new Set(addresses));
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'bookmyticket' });
});

app.get('/api/auth/session', (req, res) => {
  res.json({
    authenticated: Boolean(req.user),
    user: sanitizeUser(req.user),
    otpTtlMs: OTP_TTL_MS,
  });
});

app.post('/api/auth/register/start', async (req, res) => {
  const name = (req.body?.name || '').trim();
  const emailRaw = String(req.body?.email || '').trim();
  const email = emailRaw ? normalizeEmailAddress(emailRaw) : null;
  const phone = normalizePhone(req.body?.phone);
  const password = String(req.body?.password || '');

  if (name.length < 2) {
    res.status(400).json({ error: 'Username must be at least 2 characters.' });
    return;
  }
  if (emailRaw && !email) {
    res.status(400).json({ error: 'Enter a valid email address.' });
    return;
  }
  if (!phone) {
    res.status(400).json({ error: 'Enter a valid phone number (10-15 digits).' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters.' });
    return;
  }

  try {
    const existing = await get(`SELECT * FROM users WHERE phone = ?`, [phone]);
    if (email) {
      const takenByEmail = await get(`SELECT id FROM users WHERE email = ? AND id != ?`, [
        email,
        existing?.id || 0,
      ]);
      if (takenByEmail) {
        res.status(409).json({ error: 'Email already linked with another account.' });
        return;
      }
    }

    if (existing && existing.password_hash) {
      res.status(409).json({ error: 'Account already exists. Use login instead.' });
      return;
    }

    const passwordHash = hashPassword(password);
    let userId = existing?.id || null;
    if (existing) {
      await run(
        `UPDATE users
         SET name = ?, email = ?, phone = ?, password_hash = ?, otp_verified_at = NULL
         WHERE id = ?`,
        [name, email || existing.email || null, phone, passwordHash, existing.id]
      );
    } else {
      const inserted = await run(
        `INSERT INTO users (name, email, phone, password_hash)
         VALUES (?, ?, ?, ?)`,
        [name, email, phone, passwordHash]
      );
      userId = inserted.lastID;
    }

    const { expiresAt, delivery } = await issueOtpForUser(userId, 'register');
    res.json({
      ok: true,
      phone,
      maskedPhone: delivery.maskedPhone,
      expiresAt,
      delivery: {
        channel: delivery.channel,
        provider: delivery.provider,
        warning: delivery.warning || null,
      },
      otpPreview: delivery.otpPreview || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to start registration.' });
  }
});

app.post('/api/auth/register/verify', async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const otp = String(req.body?.otp || '').trim();
  if (!phone || !/^\d{6}$/.test(otp)) {
    res.status(400).json({ error: 'Phone and 6-digit OTP are required.' });
    return;
  }

  try {
    const user = await verifyOtpForPhone({ phone, otp, purpose: 'register' });
    await loginWithSession(req, user);
    res.json({ ok: true, user: sanitizeUser(user) });
  } catch (error) {
    res.status(400).json({ error: error.message || 'OTP verification failed.' });
  }
});

app.post('/api/auth/login/start', async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const password = String(req.body?.password || '');
  if (!phone || !password) {
    res.status(400).json({ error: 'Phone number and password are required.' });
    return;
  }

  try {
    const user = await get(`SELECT * FROM users WHERE phone = ?`, [phone]);
    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ error: 'Invalid phone number or password.' });
      return;
    }

    const { expiresAt, delivery } = await issueOtpForUser(user.id, 'login');
    res.json({
      ok: true,
      phone,
      maskedPhone: delivery.maskedPhone,
      expiresAt,
      delivery: {
        channel: delivery.channel,
        provider: delivery.provider,
        warning: delivery.warning || null,
      },
      otpPreview: delivery.otpPreview || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to start login.' });
  }
});

app.post('/api/auth/login/verify', async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const otp = String(req.body?.otp || '').trim();
  if (!phone || !/^\d{6}$/.test(otp)) {
    res.status(400).json({ error: 'Phone and 6-digit OTP are required.' });
    return;
  }

  try {
    const user = await verifyOtpForPhone({ phone, otp, purpose: 'login' });
    await loginWithSession(req, user);
    res.json({ ok: true, user: sanitizeUser(user) });
  } catch (error) {
    res.status(400).json({ error: error.message || 'OTP verification failed.' });
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

app.get('/api/home', async (_req, res) => {
  try {
    const nowShowing = await all(
      `SELECT * FROM movies
       WHERE status = 'now_showing'
       ORDER BY rating DESC, title ASC`
    );

    const upcomingLanguages = ['Telugu', 'Hindi', 'Tamil', 'Malayalam'];
    const upcomingByLanguage = {};
    for (const language of upcomingLanguages) {
      const rows = await all(
        `SELECT * FROM movies
         WHERE status = 'upcoming' AND language = ?
         ORDER BY release_date ASC`,
        [language]
      );
      upcomingByLanguage[language.toLowerCase()] = rows;
    }

    const recentUpcoming = await all(
      `SELECT * FROM movies
       WHERE status = 'upcoming'
       ORDER BY release_date ASC, rating DESC
       LIMIT 8`
    );

    const featured = nowShowing[0] || null;

    res.json({
      featured,
      nowShowing,
      upcomingByLanguage,
      upcomingTelugu: upcomingByLanguage.telugu || [],
      upcomingHindi: upcomingByLanguage.hindi || [],
      upcomingTamil: upcomingByLanguage.tamil || [],
      upcomingMalayalam: upcomingByLanguage.malayalam || [],
      recentUpcoming,
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

app.get('/api/payments/config', (_req, res) => {
  res.json({
    razorpayEnabled: RAZORPAY_ENABLED,
    razorpayKeyId: RAZORPAY_ENABLED ? RAZORPAY_KEY_ID : null,
    allowedMethods: Array.from(ALLOWED_PAYMENT_METHODS),
  });
});

app.post('/api/payments/razorpay/order', requireAuth, async (req, res) => {
  if (!RAZORPAY_ENABLED || !razorpay) {
    res.status(503).json({ error: 'Razorpay is not configured on this server.' });
    return;
  }

  const showId = Number(req.body?.showId);
  const seatLabels = Array.isArray(req.body?.seatLabels)
    ? req.body.seatLabels.map((label) => String(label).trim().toUpperCase()).filter(Boolean)
    : [];
  const lockerToken = String(req.body?.lockerToken || '').trim();

  if (!showId || !seatLabels.length || !lockerToken) {
    res.status(400).json({ error: 'showId, seatLabels and lockerToken are required.' });
    return;
  }

  try {
    const { totalAmount, showMeta } = await getPaymentScope({ showId, seatLabels, lockerToken });
    const amountPaise = Math.round(totalAmount * 100);

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `bmt-${showId}-${Date.now()}`.slice(0, 40),
      notes: {
        movie: showMeta.movieTitle,
        showId: String(showId),
        seats: seatLabels.join(','),
      },
    });

    res.json({
      ok: true,
      keyId: RAZORPAY_KEY_ID,
      orderId: order.id,
      amountPaise,
      amountInr: totalAmount,
      currency: order.currency,
    });
  } catch (error) {
    res.status(409).json({ error: error.message || 'Failed to create payment order.' });
  }
});

app.post('/api/payments/razorpay/verify', requireAuth, async (req, res) => {
  if (!RAZORPAY_ENABLED) {
    res.status(503).json({ error: 'Razorpay is not configured on this server.' });
    return;
  }

  const showId = Number(req.body?.showId);
  const paymentMethodRaw = String(req.body?.paymentMethod || 'UPI')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
  const paymentMethod = paymentMethodRaw === 'NET_BANKING' ? 'NET_BANKING' : 'UPI';
  const seatLabels = Array.isArray(req.body?.seatLabels)
    ? req.body.seatLabels.map((label) => String(label).trim().toUpperCase()).filter(Boolean)
    : [];
  const lockerToken = String(req.body?.lockerToken || '').trim();
  const orderId = String(req.body?.razorpayOrderId || '').trim();
  const paymentId = String(req.body?.razorpayPaymentId || '').trim();
  const signature = String(req.body?.razorpaySignature || '').trim();

  if (!showId || !seatLabels.length || !lockerToken || !orderId || !paymentId || !signature) {
    res.status(400).json({
      error:
        'showId, seatLabels, lockerToken, razorpayOrderId, razorpayPaymentId and razorpaySignature are required.',
    });
    return;
  }

  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  if (expectedSignature !== signature) {
    res.status(400).json({ error: 'Invalid payment signature.' });
    return;
  }

  try {
    const booking = await createBooking({
      showId,
      seatLabels,
      lockerToken,
      userId: req.user?.id,
      paymentMethod,
      paymentRefOverride: `RZP-${paymentId}`,
    });

    const seats = await getSeatSnapshot(showId);
    io.to(`show:${showId}`).emit('seats_update', { showId, seats, lockTtlMs: LOCK_TTL_MS });
    res.json({ ok: true, booking });
  } catch (error) {
    res.status(409).json({ error: error.message || 'Booking confirmation failed.' });
  }
});

app.post('/api/bookings/confirm', requireAuth, async (req, res) => {
  const showId = Number(req.body?.showId);
  const paymentMethodRaw = String(req.body?.paymentMethod || 'UPI')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
  const paymentMethod = ALLOWED_PAYMENT_METHODS.has(paymentMethodRaw) ? paymentMethodRaw : null;
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
  const socketUserId = Number(socket.request?.user?.id || socket.request?.session?.passport?.user || 0);
  const socketAuthenticated = Boolean(socketUserId);
  if (socketUserId) {
    socket.join(`user:${socketUserId}`);
  }

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
    if (!socketAuthenticated) {
      ack({ ok: false, error: 'Login required to select and book seats.' });
      return;
    }

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
    if (!socketAuthenticated) {
      ack({ ok: false, error: 'Login required to manage seat selection.' });
      return;
    }

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

setInterval(async () => {
  try {
    await seedShowsAndSeats();
  } catch (_error) {
    // Rolling showtime refresh failures should not crash the server.
  }
}, 1000 * 60 * 30);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

async function bootstrap() {
  await initializeData();
  server.listen(PORT, HOST, () => {
    const lanUrls = getLanIpv4Addresses().map((ip) => `http://${ip}:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`BookMyTicket listening on http://localhost:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`Email receipts: ${SMTP_ENABLED ? 'enabled' : 'disabled (configure SMTP_* in .env)'}`);
    if (lanUrls.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`Mobile access (same Wi-Fi): ${lanUrls.join(' | ')}`);
    }
  });
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', error);
  process.exit(1);
});
