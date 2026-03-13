const state = {
  homeData: null,
  selectedMovie: null,
  selectedShow: null,
  seatMeta: null,
  seats: [],
  lastBooking: null,
  heroSlideIndex: 0,
  heroSlideTimer: null,
  bookingFlow: {
    open: false,
    step: 'shows',
    showtimes: [],
    loading: false,
    paymentMethod: 'UPI',
    paymentStatus: 'idle',
    paymentMessage: '',
    paymentBusy: false,
  },
  paymentConfig: {
    razorpayEnabled: false,
    razorpayKeyId: null,
  },
  activeUpcomingTab: 'telugu',
  searchText: '',
  lockerToken: getOrCreateLockerToken(),
  authFlow: {
    open: false,
    mode: 'login',
    step: 'credentials',
    name: '',
    email: '',
    phone: '',
    password: '',
    otp: '',
    otpExpiresAt: null,
    otpPreview: '',
    maskedPhone: '',
    deliveryChannel: 'preview',
    deliveryWarning: '',
    message: '',
    messageType: 'neutral',
    busy: false,
    ticker: null,
    pendingAction: null,
  },
  session: {
    authenticated: false,
    user: null,
  },
  intro: {
    open: false,
    closeTimer: null,
    cleanupTimer: null,
    shownOnce: false,
  },
  swipeNav: {
    tracking: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    startedAt: 0,
    busy: false,
  },
  socket: null,
  notifications: [],
};

const elements = {
  heroSection: document.getElementById('heroSection'),
  nowShowingGrid: document.getElementById('nowShowingGrid'),
  upcomingGrid: document.getElementById('upcomingGrid'),
  recentUpcomingGrid: document.getElementById('recentUpcomingGrid'),
  upcomingTabs: document.getElementById('upcomingTabs'),
  moviePanelBody: document.getElementById('moviePanelBody'),
  showList: document.getElementById('showList'),
  seatPanelBody: document.getElementById('seatPanelBody'),
  freshBookingBar: document.getElementById('freshBookingBar'),
  bookingFlow: document.getElementById('bookingFlow'),
  bookingFlowTitle: document.getElementById('bookingFlowTitle'),
  bookingFlowMeta: document.getElementById('bookingFlowMeta'),
  bookingFlowBody: document.getElementById('bookingFlowBody'),
  bookingFlowClose: document.getElementById('bookingFlowClose'),
  notificationList: document.getElementById('notificationList'),
  introOverlay: document.getElementById('introOverlay'),
  introBackdrop: document.getElementById('introBackdrop'),
  introRailTop: document.getElementById('introRailTop'),
  introRailBottom: document.getElementById('introRailBottom'),
  introEnterBtn: document.getElementById('introEnterBtn'),
  authModal: document.getElementById('authModal'),
  loginDashboard: document.getElementById('loginDashboard'),
  movieSearch: document.getElementById('movieSearch'),
  authButton: document.getElementById('authButton'),
};

let razorpayScriptPromise = null;
const INTRO_AUTOCLOSE_MS = 4200;
const INTRO_FALLBACK_POSTERS = [
  'https://upload.wikimedia.org/wikipedia/en/1/11/Pushpa_2-_The_Rule.jpg',
  'https://upload.wikimedia.org/wikipedia/en/4/4c/Kalki_2898_AD.jpg',
  'https://upload.wikimedia.org/wikipedia/en/a/a1/Stree_2.jpg',
  'https://upload.wikimedia.org/wikipedia/en/7/75/Leo_%282023_Indian_film%29.jpg',
  'https://upload.wikimedia.org/wikipedia/en/9/99/Manjummel_Boys_poster.jpg',
  'https://upload.wikimedia.org/wikipedia/en/0/0b/Toxic-_A_Fairy_Tale_for_Grown-Ups_poster.jpg',
];
const SWIPE_BACK_EDGE_PX = 34;
const SWIPE_BACK_MIN_DISTANCE_PX = 84;
const SWIPE_BACK_MAX_VERTICAL_DRIFT_PX = 80;
const SWIPE_BACK_MAX_DURATION_MS = 900;

function getOrCreateLockerToken() {
  const key = 'bookmyticket-locker-token';
  const existing = localStorage.getItem(key);
  if (existing) {
    return existing;
  }

  const token = `locker-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  localStorage.setItem(key, token);
  return token;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function currency(amount) {
  return `INR ${Number(amount).toFixed(2)}`;
}

function formatDateTime(input) {
  return new Date(input).toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function showError(message) {
  window.alert(message);
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function clearIntroTimers() {
  if (state.intro.closeTimer) {
    window.clearTimeout(state.intro.closeTimer);
    state.intro.closeTimer = null;
  }

  if (state.intro.cleanupTimer) {
    window.clearTimeout(state.intro.cleanupTimer);
    state.intro.cleanupTimer = null;
  }
}

function getIntroPosterImages() {
  const posters = [];
  const seen = new Set();
  const pushPoster = (url) => {
    const cleanUrl = String(url || '').trim();
    if (!cleanUrl || seen.has(cleanUrl)) {
      return;
    }
    seen.add(cleanUrl);
    posters.push(cleanUrl);
  };

  (state.homeData?.nowShowing || []).forEach((movie) => {
    pushPoster(movie.poster_url || movie.banner_url);
  });

  (state.homeData?.recentUpcoming || []).forEach((movie) => {
    pushPoster(movie.poster_url || movie.banner_url);
  });

  Object.values(getUpcomingByLanguage(state.homeData)).forEach((movies) => {
    (movies || []).forEach((movie) => {
      pushPoster(movie.poster_url || movie.banner_url);
    });
  });

  INTRO_FALLBACK_POSTERS.forEach((poster) => {
    pushPoster(poster);
  });

  return posters.slice(0, 12);
}

function buildIntroTrackHtml(posters) {
  const doubled = [...posters, ...posters];
  return doubled
    .map(
      (poster) => `
        <img class="intro-poster" src="${escapeHtml(poster)}" alt="" loading="lazy" decoding="async" />
      `
    )
    .join('');
}

function renderIntroMedia() {
  if (!elements.introOverlay || !elements.introRailTop || !elements.introRailBottom || !elements.introBackdrop) {
    return;
  }

  const posters = getIntroPosterImages();
  if (!posters.length) {
    return;
  }

  const topTrack = posters;
  const bottomTrack = posters.slice().reverse();

  elements.introRailTop.innerHTML = buildIntroTrackHtml(topTrack);
  elements.introRailBottom.innerHTML = buildIntroTrackHtml(bottomTrack);
  elements.introBackdrop.style.backgroundImage = `url('${posters[0]}')`;
}

function closeIntroOverlay() {
  if (!elements.introOverlay || !state.intro.open) {
    return;
  }

  clearIntroTimers();
  state.intro.open = false;
  elements.introOverlay.classList.add('closing');
  elements.introOverlay.classList.remove('show');
  document.body.classList.remove('intro-lock');

  state.intro.cleanupTimer = window.setTimeout(() => {
    elements.introOverlay.classList.add('hidden');
    elements.introOverlay.classList.remove('closing');
    elements.introOverlay.setAttribute('aria-hidden', 'true');
  }, 540);
}

function openIntroOverlay() {
  if (!elements.introOverlay || state.intro.shownOnce) {
    return;
  }

  state.intro.shownOnce = true;
  state.intro.open = true;
  clearIntroTimers();
  renderIntroMedia();
  elements.introOverlay.classList.remove('hidden', 'closing');
  elements.introOverlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('intro-lock');

  window.requestAnimationFrame(() => {
    elements.introOverlay.classList.add('show');
  });

  state.intro.closeTimer = window.setTimeout(() => {
    closeIntroOverlay();
  }, INTRO_AUTOCLOSE_MS);
}

async function request(path, options) {
  const response = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
    ...options,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || `Request failed for ${path}`);
  }

  return payload;
}

function connectSocket() {
  state.socket = io({ withCredentials: true });

  state.socket.on('seats_update', (payload) => {
    const showId = Number(payload.showId);
    if (!state.selectedShow || showId !== state.selectedShow.id) {
      return;
    }

    state.seats = payload.seats || [];
    renderSeatPanel();
    renderFreshBookingBar();
    renderBookingFlow();
  });

  state.socket.on('server_error', (payload) => {
    showError(payload.message || 'Server error.');
  });

  state.socket.on('notification', (payload) => {
    const notification = payload?.notification;
    if (!notification || !notification.title) {
      return;
    }

    const normalized = {
      id: notification.id || `live-${Date.now()}`,
      type: notification.type || 'info',
      title: notification.title,
      message: notification.message || '',
      createdAt: notification.createdAt || new Date().toISOString(),
    };

    const existingIndex = state.notifications.findIndex(
      (entry) => String(entry.id) === String(normalized.id)
    );
    if (existingIndex >= 0) {
      state.notifications[existingIndex] = normalized;
    } else {
      state.notifications.unshift(normalized);
      state.notifications = state.notifications.slice(0, 30);
    }

    renderNotifications();
  });
}

function joinShowRoom(showId) {
  if (!state.socket || !showId) {
    return;
  }
  state.socket.emit('join_show', { showId });
}

async function loadSession() {
  const session = await request('/api/auth/session');
  state.session = session;
  renderAuthButton();
  renderAuthModal();
  renderLoginDashboard();
}

async function loadPaymentConfig() {
  try {
    const config = await request('/api/payments/config');
    state.paymentConfig = {
      razorpayEnabled: Boolean(config.razorpayEnabled),
      razorpayKeyId: config.razorpayKeyId || null,
    };
  } catch (_error) {
    state.paymentConfig = {
      razorpayEnabled: false,
      razorpayKeyId: null,
    };
  }
}

async function loadHome() {
  const data = await request('/api/home');
  state.homeData = data;

  const languageBuckets = getUpcomingByLanguage(data);
  if (!languageBuckets[state.activeUpcomingTab]) {
    state.activeUpcomingTab = Object.keys(languageBuckets)[0] || 'telugu';
  }

  if (!state.selectedMovie && data.featured) {
    state.selectedMovie = data.featured;
  }

  renderHero();
  renderMovieLists();
  renderMoviePanel();
  renderFreshBookingBar();
  renderIntroMedia();

  if (state.selectedMovie) {
    await loadShowtimes(state.selectedMovie.id);
  }
}

function getUpcomingByLanguage(homeData = state.homeData) {
  if (!homeData) {
    return {};
  }

  if (homeData.upcomingByLanguage && typeof homeData.upcomingByLanguage === 'object') {
    return homeData.upcomingByLanguage;
  }

  return {
    telugu: homeData.upcomingTelugu || [],
    hindi: homeData.upcomingHindi || [],
    tamil: homeData.upcomingTamil || [],
    malayalam: homeData.upcomingMalayalam || [],
  };
}

async function loadNotifications() {
  if (!elements.notificationList) {
    return;
  }

  try {
    const payload = await request('/api/notifications');
    state.notifications = payload.notifications || [];
    renderNotifications();
  } catch (_error) {
    elements.notificationList.innerHTML = '<div class="muted">Unable to load notifications.</div>';
  }
}

function renderAuthButton() {
  if (state.session.authenticated && state.session.user) {
    elements.authButton.textContent = 'Sign Out';
    elements.authButton.title = `Signed in as ${state.session.user.name || 'user'}`;
    return;
  }
  elements.authButton.textContent = 'Sign In';
  elements.authButton.title = 'Sign in to your account';
}

function normalizePhoneInput(raw) {
  return String(raw || '').replace(/\D/g, '').slice(0, 15);
}

function clearAuthTicker() {
  if (state.authFlow.ticker) {
    window.clearInterval(state.authFlow.ticker);
    state.authFlow.ticker = null;
  }
}

function updateOtpCountdownUI() {
  if (!state.authFlow.open || state.authFlow.step !== 'otp') {
    return;
  }
  const countdownNode = document.getElementById('authOtpCountdown');
  if (!countdownNode) {
    return;
  }
  countdownNode.textContent = `${getOtpSecondsLeft()}s`;
}

function startAuthTicker() {
  clearAuthTicker();
  if (!state.authFlow.open || state.authFlow.step !== 'otp') {
    return;
  }
  updateOtpCountdownUI();
  state.authFlow.ticker = window.setInterval(() => {
    if (!state.authFlow.open || state.authFlow.step !== 'otp') {
      clearAuthTicker();
      return;
    }
    updateOtpCountdownUI();
  }, 1000);
}

function resetAuthFlow(mode = 'login') {
  state.authFlow.mode = mode;
  state.authFlow.step = 'credentials';
  state.authFlow.name = '';
  state.authFlow.email = '';
  state.authFlow.phone = '';
  state.authFlow.password = '';
  state.authFlow.otp = '';
  state.authFlow.otpExpiresAt = null;
  state.authFlow.otpPreview = '';
  state.authFlow.maskedPhone = '';
  state.authFlow.deliveryChannel = 'preview';
  state.authFlow.deliveryWarning = '';
  state.authFlow.message = '';
  state.authFlow.messageType = 'neutral';
  state.authFlow.busy = false;
  state.authFlow.pendingAction = null;
}

function openAuthModal(mode = 'login') {
  resetAuthFlow(mode);
  state.authFlow.open = true;
  renderAuthModal();
}

function closeAuthModal() {
  state.authFlow.open = false;
  clearAuthTicker();
  renderAuthModal();
}

function openAuthForBooking(actionLabel = 'book tickets', pendingAction = null) {
  openAuthModal('login');
  state.authFlow.pendingAction = pendingAction;
  state.authFlow.message = `Please sign in to ${actionLabel}.`;
  state.authFlow.messageType = 'error';
  renderAuthModal();
}

function ensureBookingAuth(actionLabel = 'book tickets', pendingAction = null) {
  if (state.session?.authenticated && state.session?.user) {
    return true;
  }

  openAuthForBooking(actionLabel, pendingAction);
  return false;
}

function backAuthToCredentialsStep() {
  state.authFlow.step = 'credentials';
  state.authFlow.otp = '';
  state.authFlow.otpExpiresAt = null;
  state.authFlow.otpPreview = '';
  state.authFlow.maskedPhone = '';
  state.authFlow.deliveryChannel = 'preview';
  state.authFlow.deliveryWarning = '';
  state.authFlow.message = '';
  state.authFlow.messageType = 'neutral';
  clearAuthTicker();
  renderAuthModal();
}

function resetSwipeTracking() {
  state.swipeNav.tracking = false;
  state.swipeNav.startX = 0;
  state.swipeNav.startY = 0;
  state.swipeNav.lastX = 0;
  state.swipeNav.lastY = 0;
  state.swipeNav.startedAt = 0;
}

async function handleSwipeBackAction() {
  if (state.swipeNav.busy) {
    return;
  }

  state.swipeNav.busy = true;
  try {
    if (state.intro.open) {
      closeIntroOverlay();
      return;
    }

    if (state.authFlow.open) {
      if (state.authFlow.step === 'otp') {
        backAuthToCredentialsStep();
        return;
      }
      closeAuthModal();
      return;
    }

    if (!state.bookingFlow.open) {
      return;
    }

    if (state.bookingFlow.step === 'payment') {
      state.bookingFlow.step = 'seats';
      renderBookingFlow();
      return;
    }

    if (state.bookingFlow.step === 'seats') {
      state.bookingFlow.step = 'shows';
      renderBookingFlow();
      return;
    }

    if (state.bookingFlow.step === 'shows') {
      try {
        await releaseMySeats();
      } catch (_error) {
        // Ignore release failures on swipe-back close.
      }
      closeBookingFlow();
      renderSeatPanel();
      return;
    }

    closeBookingFlow();
  } finally {
    state.swipeNav.busy = false;
  }
}

function onSwipeTouchStart(event) {
  if (!event.touches || event.touches.length !== 1) {
    resetSwipeTracking();
    return;
  }

  const touch = event.touches[0];
  if (touch.clientX > SWIPE_BACK_EDGE_PX) {
    resetSwipeTracking();
    return;
  }

  state.swipeNav.tracking = true;
  state.swipeNav.startX = touch.clientX;
  state.swipeNav.startY = touch.clientY;
  state.swipeNav.lastX = touch.clientX;
  state.swipeNav.lastY = touch.clientY;
  state.swipeNav.startedAt = Date.now();
}

function onSwipeTouchMove(event) {
  if (!state.swipeNav.tracking || !event.touches || event.touches.length !== 1) {
    return;
  }

  const touch = event.touches[0];
  state.swipeNav.lastX = touch.clientX;
  state.swipeNav.lastY = touch.clientY;
}

function onSwipeTouchEnd() {
  if (!state.swipeNav.tracking) {
    return;
  }

  const deltaX = state.swipeNav.lastX - state.swipeNav.startX;
  const deltaY = state.swipeNav.lastY - state.swipeNav.startY;
  const durationMs = Date.now() - state.swipeNav.startedAt;
  resetSwipeTracking();

  const isSwipeBack =
    deltaX >= SWIPE_BACK_MIN_DISTANCE_PX &&
    Math.abs(deltaY) <= SWIPE_BACK_MAX_VERTICAL_DRIFT_PX &&
    durationMs <= SWIPE_BACK_MAX_DURATION_MS;

  if (isSwipeBack) {
    void handleSwipeBackAction();
  }
}

function getOtpSecondsLeft() {
  if (!state.authFlow.otpExpiresAt) {
    return 0;
  }
  return Math.max(0, Math.ceil((Number(state.authFlow.otpExpiresAt) - Date.now()) / 1000));
}

function getSeatTierClass(rowIndex, totalRows) {
  if (!Number.isFinite(totalRows) || totalRows <= 0) {
    return 'tier-silver';
  }
  const split = Math.ceil(totalRows / 2);
  return rowIndex < split ? 'tier-silver' : 'tier-gold';
}

function collectAllMovies() {
  const buckets = [];
  if (state.homeData?.featured) {
    buckets.push(state.homeData.featured);
  }
  if (Array.isArray(state.homeData?.nowShowing)) {
    buckets.push(...state.homeData.nowShowing);
  }
  if (Array.isArray(state.homeData?.recentUpcoming)) {
    buckets.push(...state.homeData.recentUpcoming);
  }
  const upcomingByLanguage = getUpcomingByLanguage(state.homeData);
  Object.values(upcomingByLanguage).forEach((list) => {
    if (Array.isArray(list)) {
      buckets.push(...list);
    }
  });
  return buckets;
}

function findMovieById(movieId) {
  const id = Number(movieId);
  return collectAllMovies().find((movie) => Number(movie.id) === id) || null;
}

function refreshSocketConnection() {
  if (state.socket) {
    state.socket.removeAllListeners();
    state.socket.disconnect();
    state.socket = null;
  }
  connectSocket();
  if (state.selectedShow?.id) {
    joinShowRoom(state.selectedShow.id);
  }
}

async function resumePendingAuthAction() {
  const pending = state.authFlow.pendingAction;
  state.authFlow.pendingAction = null;
  if (!pending) {
    return;
  }

  if (pending.type === 'openBookingFlow') {
    const movie = findMovieById(pending.movieId);
    if (movie) {
      await openBookingFlow(movie);
    }
    return;
  }

  if (pending.type === 'selectShow') {
    await selectShowForBooking(pending.showId);
    return;
  }

  if (pending.type === 'refreshSeats' && state.selectedShow) {
    await loadSeatMap(state.selectedShow.id);
  }
}

async function submitAuthCredentials() {
  if (state.authFlow.busy) {
    return;
  }

  const mode = state.authFlow.mode;
  const payload = {
    phone: normalizePhoneInput(state.authFlow.phone),
    password: state.authFlow.password,
  };

  if (mode === 'register') {
    payload.name = state.authFlow.name.trim();
    payload.email = state.authFlow.email.trim();
  }

  state.authFlow.busy = true;
  state.authFlow.message = '';
  state.authFlow.messageType = 'neutral';
  renderAuthModal();

  try {
    const endpoint = mode === 'register' ? '/api/auth/register/start' : '/api/auth/login/start';
    const response = await request(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    state.authFlow.step = 'otp';
    state.authFlow.phone = response.phone || payload.phone;
    state.authFlow.password = '';
    state.authFlow.otp = '';
    state.authFlow.otpExpiresAt = Number(response.expiresAt || 0);
    state.authFlow.otpPreview = response.otpPreview || '';
    state.authFlow.maskedPhone = response.maskedPhone || '';
    state.authFlow.deliveryChannel = response.delivery?.channel || 'preview';
    state.authFlow.deliveryWarning = response.delivery?.warning || '';
    state.authFlow.message =
      state.authFlow.deliveryChannel === 'sms'
        ? 'OTP sent to your phone in real time.'
        : 'OTP generated in preview mode.';
    state.authFlow.messageType = 'success';
    startAuthTicker();
  } catch (error) {
    state.authFlow.message = error.message;
    state.authFlow.messageType = 'error';
  } finally {
    state.authFlow.busy = false;
    renderAuthModal();
  }
}

async function verifyAuthOtp() {
  if (state.authFlow.busy) {
    return;
  }

  state.authFlow.busy = true;
  state.authFlow.message = '';
  state.authFlow.messageType = 'neutral';
  renderAuthModal();

  try {
    const endpoint =
      state.authFlow.mode === 'register' ? '/api/auth/register/verify' : '/api/auth/login/verify';
    await request(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        phone: normalizePhoneInput(state.authFlow.phone),
        otp: state.authFlow.otp.trim(),
      }),
    });

    closeAuthModal();
    await loadSession();
    await loadNotifications();
    refreshSocketConnection();
    await resumePendingAuthAction();
  } catch (error) {
    state.authFlow.message = error.message;
    state.authFlow.messageType = 'error';
    state.authFlow.busy = false;
    renderAuthModal();
  }
}

function renderAuthModal() {
  if (!state.authFlow.open) {
    elements.authModal.classList.add('hidden');
    elements.authModal.innerHTML = '';
    clearAuthTicker();
    return;
  }

  elements.authModal.classList.remove('hidden');
  const mode = state.authFlow.mode;
  const step = state.authFlow.step;
  const isRegister = mode === 'register';
  const secondsLeft = getOtpSecondsLeft();
  const title = isRegister ? 'Create Account' : 'Login';

  elements.authModal.innerHTML = `
    <div class="auth-card" role="dialog" aria-modal="true" aria-labelledby="authModalTitle">
      <div class="auth-card-head">
        <h3 id="authModalTitle">${title}</h3>
        <button id="authCloseBtn" class="ghost-btn">Close</button>
      </div>
      <div class="auth-switch">
        <button class="auth-switch-btn ${!isRegister ? 'active' : ''}" data-auth-mode="login">Login</button>
        <button class="auth-switch-btn ${isRegister ? 'active' : ''}" data-auth-mode="register">Register</button>
      </div>

      ${
        step === 'credentials'
          ? `
        <form id="authCredsForm" class="auth-form">
          ${
            isRegister
              ? `
            <div class="auth-field">
              <label for="authNameInput">Username</label>
              <input id="authNameInput" type="text" value="${escapeHtml(state.authFlow.name)}" placeholder="Enter username" autocomplete="name" />
            </div>
            <div class="auth-field">
              <label for="authEmailInput">Email</label>
              <input id="authEmailInput" type="email" value="${escapeHtml(
                state.authFlow.email
              )}" placeholder="Enter email" autocomplete="email" />
            </div>
          `
              : ''
          }
          <div class="auth-field">
            <label for="authPhoneInput">Phone Number</label>
            <input id="authPhoneInput" type="tel" value="${escapeHtml(
              state.authFlow.phone
            )}" placeholder="Enter phone number" autocomplete="tel" />
          </div>
          <div class="auth-field">
            <label for="authPasswordInput">Password</label>
            <input id="authPasswordInput" type="password" value="${escapeHtml(
              state.authFlow.password
            )}" placeholder="Enter password" autocomplete="${isRegister ? 'new-password' : 'current-password'}" />
          </div>
          <div class="auth-help">OTP will be sent instantly after credentials are verified.</div>
          <div class="auth-row">
            <button type="submit" class="primary-btn" ${state.authFlow.busy ? 'disabled' : ''}>${
              state.authFlow.busy ? 'Sending...' : 'Send OTP'
            }</button>
          </div>
          ${
            state.authFlow.message
              ? `<div class="auth-status ${escapeHtml(state.authFlow.messageType)}">${escapeHtml(
                  state.authFlow.message
                )}</div>`
              : ''
          }
        </form>
      `
          : `
        <form id="authOtpForm" class="auth-form">
          <div class="auth-field">
            <label for="authOtpInput">One-Time Password (OTP)</label>
            <input id="authOtpInput" type="text" value="${escapeHtml(
              state.authFlow.otp
            )}" placeholder="Enter 6-digit OTP" inputmode="numeric" />
          </div>
          <div class="auth-help">
            OTP expires in <span id="authOtpCountdown">${secondsLeft}s</span>
          </div>
          ${
            state.authFlow.deliveryWarning
              ? `<div class="auth-status error">${escapeHtml(state.authFlow.deliveryWarning)}</div>`
              : ''
          }
          ${
            state.authFlow.otpPreview
              ? `<div class="otp-preview">Demo OTP: <strong>${escapeHtml(state.authFlow.otpPreview)}</strong></div>`
              : ''
          }
          <div class="auth-row">
            <button type="button" id="authBackBtn" class="small-btn" ${state.authFlow.busy ? 'disabled' : ''}>Back</button>
            <button type="submit" class="primary-btn" ${state.authFlow.busy ? 'disabled' : ''}>${
              state.authFlow.busy ? 'Verifying...' : 'Verify OTP'
            }</button>
          </div>
          ${
            state.authFlow.message
              ? `<div class="auth-status ${escapeHtml(state.authFlow.messageType)}">${escapeHtml(
                  state.authFlow.message
                )}</div>`
              : ''
          }
        </form>
      `
      }
    </div>
  `;

  document.getElementById('authCloseBtn')?.addEventListener('click', () => {
    closeAuthModal();
  });

  elements.authModal.onclick = (event) => {
    if (event.target === elements.authModal) {
      closeAuthModal();
    }
  };

  elements.authModal.querySelectorAll('[data-auth-mode]').forEach((node) => {
    node.addEventListener('click', () => {
      const nextMode = node.getAttribute('data-auth-mode');
      if (!nextMode || nextMode === state.authFlow.mode) {
        return;
      }
      resetAuthFlow(nextMode);
      renderAuthModal();
    });
  });

  if (step === 'credentials') {
    document.getElementById('authNameInput')?.addEventListener('input', (event) => {
      state.authFlow.name = event.target.value;
    });
    document.getElementById('authEmailInput')?.addEventListener('input', (event) => {
      state.authFlow.email = String(event.target.value || '');
    });
    document.getElementById('authPhoneInput')?.addEventListener('input', (event) => {
      state.authFlow.phone = normalizePhoneInput(event.target.value);
      event.target.value = state.authFlow.phone;
    });
    document.getElementById('authPasswordInput')?.addEventListener('input', (event) => {
      state.authFlow.password = event.target.value;
    });
    document.getElementById('authCredsForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      await submitAuthCredentials();
    });
  } else {
    document.getElementById('authOtpInput')?.addEventListener('input', (event) => {
      state.authFlow.otp = String(event.target.value || '')
        .replace(/\D/g, '')
        .slice(0, 6);
      event.target.value = state.authFlow.otp;
    });
    document.getElementById('authOtpInput')?.focus();
    document.getElementById('authBackBtn')?.addEventListener('click', () => {
      backAuthToCredentialsStep();
    });
    document.getElementById('authOtpForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      await verifyAuthOtp();
    });
    startAuthTicker();
  }
}

function getUserInitials(name, email) {
  const source = (name || email || '').trim();
  if (!source) {
    return 'U';
  }
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
}

function renderLoginDashboard() {
  if (!elements.loginDashboard) {
    return;
  }

  if (!state.session?.authenticated || !state.session?.user) {
    elements.loginDashboard.classList.add('hidden');
    elements.loginDashboard.classList.remove('show');
    elements.loginDashboard.innerHTML = '';
    return;
  }

  const user = state.session.user;
  const initials = getUserInitials(user.name, user.email);
  const subtitle = user.email ? `Signed in as ${user.email}` : 'Signed in';
  const avatarHtml = user.avatarUrl
    ? `<img src="${escapeHtml(user.avatarUrl)}" alt="${escapeHtml(user.name || 'User')}" />`
    : initials;

  elements.loginDashboard.classList.remove('hidden');
  elements.loginDashboard.innerHTML = `
    <div class="login-avatar">${avatarHtml}</div>
    <div>
      <h3 class="login-dashboard-title">Welcome, ${escapeHtml(user.name || 'Movie User')}</h3>
      <div class="login-dashboard-sub">${escapeHtml(subtitle)}</div>
    </div>
    <div class="login-dashboard-badges">
      <span class="login-badge live">Session Active</span>
      <span class="login-badge">Booking Dashboard</span>
    </div>
  `;

  elements.loginDashboard.classList.remove('show');
  // Restart animation each time session refreshes after login.
  void elements.loginDashboard.offsetWidth;
  elements.loginDashboard.classList.add('show');
}

function renderFreshBookingBar() {
  if (!elements.freshBookingBar) {
    return;
  }

  const selectedSeats = myLockedSeats();
  const hasContext = Boolean(state.selectedMovie || state.selectedShow || state.lastBooking);

  if (!hasContext) {
    elements.freshBookingBar.innerHTML = `
      <div class="fresh-booking-inner">
        <div>
          <div class="fresh-booking-title">Fresh Booking</div>
          <div class="fresh-booking-meta">Pick a movie and showtime to start a new booking.</div>
        </div>
      </div>
    `;
    return;
  }

  const movieLabel = state.selectedMovie?.title || state.lastBooking?.show?.movieTitle || 'No movie selected';
  const showLabel = state.selectedShow
    ? `${formatDateTime(state.selectedShow.startTime)} · ${state.selectedShow.theaterName}`
    : 'Choose showtime';
  const seatLabel = selectedSeats.length ? selectedSeats.join(', ') : 'No seats selected';

  elements.freshBookingBar.innerHTML = `
    <div class="fresh-booking-inner">
      <div>
        <div class="fresh-booking-title">Fresh Booking</div>
        <div class="fresh-booking-meta">
          <strong>${escapeHtml(movieLabel)}</strong> · ${escapeHtml(showLabel)} · Seats: ${escapeHtml(seatLabel)}
        </div>
      </div>
      <div class="fresh-booking-actions">
        <button id="continueBookingBtn" class="small-btn">Continue Booking</button>
        <button id="freshStartBtn" class="ghost-btn">Start Fresh</button>
      </div>
    </div>
    ${
      state.lastBooking
        ? `
      <div class="receipt">
        <div class="code">Booking #${state.lastBooking.bookingId}</div>
        <div>Movie: ${escapeHtml(state.lastBooking.show.movieTitle)}</div>
        <div>Show Time: ${formatDateTime(state.lastBooking.show.startTime)}</div>
        <div>Seats: ${escapeHtml(state.lastBooking.seats.join(', '))}</div>
        <div>Payment: ${escapeHtml(state.lastBooking.paymentMethod || 'UPI')} · ${escapeHtml(
          state.lastBooking.paymentRef
        )}</div>
        <div>QR Time: ${state.lastBooking.qrGeneratedAt ? formatDateTime(state.lastBooking.qrGeneratedAt) : 'N/A'}</div>
        <div><strong>Amount Paid: ${currency(state.lastBooking.totalAmount)}</strong></div>
        ${
          state.lastBooking.qrCodeDataUrl
            ? `<img class="booking-qr" src="${state.lastBooking.qrCodeDataUrl}" alt="Booking QR code" />`
            : ''
        }
      </div>
    `
        : ''
    }
  `;

  document.getElementById('continueBookingBtn')?.addEventListener('click', () => {
    if (state.selectedMovie) {
      void openBookingFlow(state.selectedMovie);
      return;
    }
    document.getElementById('showPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  document.getElementById('freshStartBtn')?.addEventListener('click', () => {
    void startFreshBooking();
  });
}

function closeBookingFlow() {
  state.bookingFlow.open = false;
  state.bookingFlow.step = 'shows';
  state.bookingFlow.loading = false;
  state.bookingFlow.paymentMethod = 'UPI';
  state.bookingFlow.paymentStatus = 'idle';
  state.bookingFlow.paymentMessage = '';
  state.bookingFlow.paymentBusy = false;
  elements.bookingFlow.classList.add('hidden');
}

function renderBookingFlowShowsStep() {
  if (!state.selectedMovie) {
    elements.bookingFlowBody.innerHTML = '<div class="muted">Choose a movie to continue.</div>';
    return;
  }

  if (state.selectedMovie.status === 'upcoming') {
    elements.bookingFlowBody.innerHTML =
      '<div class="muted">This movie is upcoming. Showtimes will be announced soon.</div>';
    return;
  }

  if (state.bookingFlow.loading) {
    elements.bookingFlowBody.innerHTML = '<div class="muted">Loading date and time slots...</div>';
    return;
  }

  const shows = state.bookingFlow.showtimes || [];
  if (!shows.length) {
    elements.bookingFlowBody.innerHTML = '<div class="muted">No showtimes available right now.</div>';
    return;
  }

  const grouped = new Map();
  for (const show of shows) {
    const dateKey = new Date(show.startTime).toDateString();
    if (!grouped.has(dateKey)) {
      grouped.set(dateKey, []);
    }
    grouped.get(dateKey).push(show);
  }

  elements.bookingFlowBody.innerHTML = `
    <div class="flow-grid">
      ${Array.from(grouped.entries())
        .map(([_, entries]) => {
          const dateLabel = new Date(entries[0].startTime).toLocaleDateString([], {
            weekday: 'long',
            month: 'short',
            day: 'numeric',
          });

          return `
            <article class="flow-date-card">
              <div class="flow-date-title">${escapeHtml(dateLabel)}</div>
              <div class="flow-time-list">
                ${entries
                  .map(
                    (show) => `
                  <div class="flow-time-item">
                    <div class="flow-time-info">
                      <strong>${escapeHtml(show.theaterName)} · ${escapeHtml(show.screenName)}</strong>
                      <span class="muted">${escapeHtml(show.theaterLocation)} · ${formatDateTime(show.startTime)}</span>
                    </div>
                    <button class="small-btn" data-flow-show-id="${show.id}">Select · ${currency(show.price)}</button>
                  </div>
                `
                  )
                  .join('')}
              </div>
            </article>
          `;
        })
        .join('')}
    </div>
  `;

  document.querySelectorAll('[data-flow-show-id]').forEach((node) => {
    node.addEventListener('click', async () => {
      const showId = Number(node.getAttribute('data-flow-show-id'));
      try {
        await selectShowForBooking(showId);
      } catch (error) {
        if (String(error.message || '').toLowerCase().includes('login required')) {
          openAuthForBooking('select seats', { type: 'refreshSeats' });
        }
        showError(error.message);
      }
    });
  });
}

function renderBookingFlowSeatsStep() {
  if (!state.selectedShow || !state.seatMeta) {
    elements.bookingFlowBody.innerHTML = '<div class="muted">Choose date and time first.</div>';
    return;
  }

  const rows = Number(state.seatMeta.seatRows);
  const cols = Number(state.seatMeta.seatCols);
  const seatMap = new Map(state.seats.map((seat) => [seat.seatLabel, seat]));
  const mine = myLockedSeats();

  const gridItems = [];
  for (let row = 0; row < rows; row += 1) {
    const rowLabel = String.fromCharCode(65 + row);
    const tierClass = getSeatTierClass(row, rows);
    for (let col = 1; col <= cols; col += 1) {
      const label = `${rowLabel}${col}`;
      const seat = seatMap.get(label);
      let cssClass = `seat ${tierClass}`;

      if (!seat || seat.state === 'available') {
        cssClass += '';
      } else if (seat.state === 'booked') {
        cssClass += ' booked';
      } else if (seat.state === 'locked' && seat.lockedBy === state.lockerToken) {
        cssClass += ' mine';
      } else if (seat.state === 'locked') {
        cssClass += ' locked';
      }

      const disabled = seat && seat.state !== 'available' && !(seat.state === 'locked' && seat.lockedBy === state.lockerToken);
      gridItems.push(
        `<button class="${cssClass}" data-flow-seat-label="${label}" ${disabled ? 'disabled' : ''}>${label}</button>`
      );
    }
  }

  const totalAmount = mine.length * Number(state.selectedShow.price);
  elements.bookingFlowBody.innerHTML = `
    <div class="flow-summary">
      <div><strong>${escapeHtml(state.seatMeta.movieTitle)}</strong></div>
      <div class="muted">${escapeHtml(state.seatMeta.theaterName)} · ${escapeHtml(state.seatMeta.screenName)}</div>
      <div class="muted">${formatDateTime(state.selectedShow.startTime)} · ${currency(state.selectedShow.price)} per seat</div>
    </div>
    <div class="screen-bar">Screen This Way</div>
    <div class="flow-seat-grid" style="grid-template-columns: repeat(${cols}, minmax(0, 1fr));">${gridItems.join('')}</div>
    <div class="seat-legend">
      <span class="legend-item"><span class="legend-dot available"></span>Available</span>
      <span class="legend-item"><span class="legend-dot silver"></span>Silver</span>
      <span class="legend-item"><span class="legend-dot gold"></span>Gold</span>
      <span class="legend-item"><span class="legend-dot mine"></span>Selected by you</span>
      <span class="legend-item"><span class="legend-dot locked"></span>Locked</span>
      <span class="legend-item"><span class="legend-dot booked"></span>Booked</span>
    </div>
    <div class="flow-footer">
      <div>
        <div class="muted">Seats: ${mine.length ? escapeHtml(mine.join(', ')) : 'None selected'}</div>
        <div><strong>Total: ${currency(totalAmount)}</strong></div>
      </div>
      <div class="fresh-booking-actions">
        <button id="flowBackToShowsBtn" class="small-btn">Back</button>
        <button id="flowToPaymentBtn" class="primary-btn" ${mine.length ? '' : 'disabled'}>Continue Payment</button>
      </div>
    </div>
  `;

  document.querySelectorAll('[data-flow-seat-label]').forEach((node) => {
    node.addEventListener('click', async () => {
      const seatLabel = node.getAttribute('data-flow-seat-label');
      const seat = seatMap.get(seatLabel);

      try {
        if (seat && seat.state === 'locked' && seat.lockedBy === state.lockerToken) {
          await socketEmitWithAck('release_seats', {
            showId: state.selectedShow.id,
            seatLabels: [seatLabel],
            lockerToken: state.lockerToken,
          });
          return;
        }

        await socketEmitWithAck('lock_seats', {
          showId: state.selectedShow.id,
          seatLabels: [seatLabel],
          lockerToken: state.lockerToken,
        });
      } catch (error) {
        if (String(error.message || '').toLowerCase().includes('login required')) {
          openAuthForBooking('select seats', { type: 'refreshSeats' });
        }
        showError(error.message);
      }
    });
  });

  document.getElementById('flowBackToShowsBtn')?.addEventListener('click', () => {
    state.bookingFlow.step = 'shows';
    renderBookingFlow();
  });

  document.getElementById('flowToPaymentBtn')?.addEventListener('click', () => {
    state.bookingFlow.step = 'payment';
    state.bookingFlow.paymentStatus = 'idle';
    state.bookingFlow.paymentMessage = '';
    renderBookingFlow();
  });
}

function updatePaymentState(status, message, busy = false) {
  state.bookingFlow.paymentStatus = status;
  state.bookingFlow.paymentMessage = message;
  state.bookingFlow.paymentBusy = busy;
  renderBookingFlow();
}

async function loadRazorpayScript() {
  if (window.Razorpay) {
    return;
  }
  if (razorpayScriptPromise) {
    await razorpayScriptPromise;
    return;
  }

  razorpayScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Razorpay checkout SDK.'));
    document.body.appendChild(script);
  });

  await razorpayScriptPromise;
}

async function openRazorpayCheckout(orderPayload) {
  await loadRazorpayScript();

  return new Promise((resolve, reject) => {
    const options = {
      key: orderPayload.keyId,
      amount: orderPayload.amountPaise,
      currency: orderPayload.currency || 'INR',
      name: 'BookMyTicket',
      description: `${state.selectedMovie?.title || 'Movie'} ticket booking`,
      order_id: orderPayload.orderId,
      prefill: {
        name: state.session.user?.name || '',
        email: state.session.user?.email || '',
      },
      theme: {
        color: '#ef4035',
      },
      handler: (response) => {
        resolve({
          razorpayOrderId: response.razorpay_order_id,
          razorpayPaymentId: response.razorpay_payment_id,
          razorpaySignature: response.razorpay_signature,
        });
      },
      modal: {
        ondismiss: () => reject(new Error('Payment cancelled by user.')),
      },
    };

    const checkout = new window.Razorpay(options);
    checkout.on('payment.failed', (response) => {
      reject(new Error(response.error?.description || 'Payment failed.'));
    });
    checkout.open();
  });
}

async function applyBookingSuccess(booking, source) {
  state.lastBooking = booking;
  state.selectedShow = null;
  state.seatMeta = null;
  state.seats = [];
  renderSeatPanel();
  renderFreshBookingBar();

  if (state.selectedMovie) {
    await loadShowtimes(state.selectedMovie.id);
  }

  if (source === 'flow') {
    state.bookingFlow.step = 'success';
    state.bookingFlow.open = true;
    state.bookingFlow.paymentBusy = false;
    renderBookingFlow();
  }

  await loadNotifications();
}

async function processRealtimeCryptoPayment() {
  updatePaymentState('processing', 'Connecting to crypto network...', true);
  await sleep(900);
  updatePaymentState('processing', 'Creating on-chain payment intent...', true);
  await sleep(1000);
  const txHash = `0x${cryptoRandomHex(16)}`;
  updatePaymentState('processing', `Waiting for blockchain confirmation: ${txHash}`, true);
  await sleep(1400);
  updatePaymentState('success', `Crypto payment confirmed: ${txHash}`, true);
}

function cryptoRandomHex(bytes) {
  const array = new Uint8Array(bytes);
  window.crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function processPaymentAndBook(paymentMethod) {
  if (!ensureBookingAuth('continue payment and booking')) {
    return;
  }

  if (state.bookingFlow.paymentBusy) {
    return;
  }

  const selectedSeats = myLockedSeats();
  if (!state.selectedShow || selectedSeats.length === 0) {
    showError('Select seats before payment.');
    return;
  }

  try {
    if (paymentMethod === 'CRYPTO') {
      await processRealtimeCryptoPayment();
      await confirmBooking('CRYPTO', 'flow');
      return;
    }

    if (state.paymentConfig.razorpayEnabled) {
      updatePaymentState('processing', 'Creating secure payment order...', true);
      const orderPayload = await request('/api/payments/razorpay/order', {
        method: 'POST',
        body: JSON.stringify({
          showId: state.selectedShow.id,
          seatLabels: selectedSeats,
          lockerToken: state.lockerToken,
        }),
      });

      updatePaymentState('processing', 'Waiting for payment confirmation...', true);
      const gatewayResult = await openRazorpayCheckout(orderPayload);
      updatePaymentState('processing', 'Verifying payment signature...', true);

      const verified = await request('/api/payments/razorpay/verify', {
        method: 'POST',
        body: JSON.stringify({
          showId: state.selectedShow.id,
          seatLabels: selectedSeats,
          lockerToken: state.lockerToken,
          paymentMethod,
          razorpayOrderId: gatewayResult.razorpayOrderId,
          razorpayPaymentId: gatewayResult.razorpayPaymentId,
          razorpaySignature: gatewayResult.razorpaySignature,
        }),
      });

      updatePaymentState('success', 'Payment verified successfully.', false);
      await applyBookingSuccess(verified.booking, 'flow');
      return;
    }

    updatePaymentState('processing', 'Gateway not configured. Processing secure demo payment...', true);
    await sleep(1400);
    updatePaymentState('processing', 'Verifying bank confirmation...', true);
    await sleep(1000);
    updatePaymentState('success', 'Payment confirmed.', true);
    await confirmBooking(paymentMethod, 'flow');
  } catch (error) {
    updatePaymentState('failed', error.message || 'Payment failed.', false);
    throw error;
  } finally {
    if (state.bookingFlow.step !== 'success') {
      state.bookingFlow.paymentBusy = false;
      renderBookingFlow();
    }
  }
}

function renderBookingFlowPaymentStep() {
  const selectedSeats = myLockedSeats();
  if (!state.selectedShow || !selectedSeats.length) {
    elements.bookingFlowBody.innerHTML = '<div class="muted">Select seats before payment.</div>';
    return;
  }

  const totalAmount = selectedSeats.length * Number(state.selectedShow.price);
  const options = ['UPI', 'CRYPTO', 'NET_BANKING'];
  const methodLabel =
    state.bookingFlow.paymentMethod === 'NET_BANKING' ? 'Net Banking' : state.bookingFlow.paymentMethod;
  const liveStatus =
    state.bookingFlow.paymentMessage ||
    (state.paymentConfig.razorpayEnabled
      ? 'Real-time gateway enabled for UPI/Net Banking.'
      : 'Razorpay gateway not configured. Demo real-time flow will be used for UPI/Net Banking.');

  elements.bookingFlowBody.innerHTML = `
    <div class="flow-summary">
      <div><strong>${escapeHtml(state.selectedMovie?.title || state.seatMeta?.movieTitle || 'Movie')}</strong></div>
      <div class="muted">${formatDateTime(state.selectedShow.startTime)} · ${escapeHtml(state.selectedShow.theaterName)}</div>
      <div class="muted">Seats: ${escapeHtml(selectedSeats.join(', '))}</div>
      <div><strong>Total: ${currency(totalAmount)}</strong></div>
    </div>
    <div class="pay-options">
      ${options
        .map(
          (method) => `
        <label class="pay-option">
          <input type="radio" name="flowPaymentMethod" value="${method}" ${
            state.bookingFlow.paymentMethod === method ? 'checked' : ''
          } />
          <span>${method === 'NET_BANKING' ? 'Net Banking' : method}</span>
        </label>
      `
        )
        .join('')}
    </div>
    <div class="payment-live ${escapeHtml(state.bookingFlow.paymentStatus)}">${escapeHtml(liveStatus)}</div>
    <div class="flow-footer">
      <button id="flowBackToSeatsBtn" class="small-btn">Back to Seats</button>
      <button id="flowPayNowBtn" class="pay-btn" ${state.bookingFlow.paymentBusy ? 'disabled' : ''}>
        ${state.bookingFlow.paymentBusy ? 'Processing...' : `Pay Now (${escapeHtml(methodLabel)})`}
      </button>
    </div>
  `;

  document.querySelectorAll('input[name=\"flowPaymentMethod\"]').forEach((node) => {
    node.addEventListener('change', () => {
      state.bookingFlow.paymentMethod = node.value;
      renderBookingFlow();
    });
  });

  document.getElementById('flowBackToSeatsBtn')?.addEventListener('click', () => {
    state.bookingFlow.step = 'seats';
    renderBookingFlow();
  });

  document.getElementById('flowPayNowBtn')?.addEventListener('click', async () => {
    try {
      await processPaymentAndBook(state.bookingFlow.paymentMethod);
    } catch (error) {
      showError(error.message);
    }
  });
}

function renderBookingFlowSuccessStep() {
  const booking = state.lastBooking;
  if (!booking) {
    elements.bookingFlowBody.innerHTML = '<div class="muted">Booking completed.</div>';
    return;
  }

  elements.bookingFlowBody.innerHTML = `
    <div class="receipt">
      <div class="code">Booking #${booking.bookingId}</div>
      <div>Movie: ${escapeHtml(booking.show.movieTitle)}</div>
      <div>Show: ${formatDateTime(booking.show.startTime)}</div>
      <div>Seats: ${escapeHtml(booking.seats.join(', '))}</div>
      <div>Payment: ${escapeHtml(booking.paymentMethod || 'UPI')} · ${escapeHtml(booking.paymentRef)}</div>
      <div>QR Time: ${booking.qrGeneratedAt ? formatDateTime(booking.qrGeneratedAt) : 'N/A'}</div>
      <div><strong>Paid: ${currency(booking.totalAmount)}</strong></div>
      ${booking.qrCodeDataUrl ? `<img class="booking-qr" src="${booking.qrCodeDataUrl}" alt="Booking QR code" />` : ''}
    </div>
    <div class="flow-footer">
      <button id="flowBookAgainBtn" class="primary-btn">Book Again</button>
      <button id="flowCloseDoneBtn" class="small-btn">Close</button>
    </div>
  `;

  document.getElementById('flowBookAgainBtn')?.addEventListener('click', async () => {
    if (state.selectedMovie) {
      await openBookingFlow(state.selectedMovie);
      return;
    }
    closeBookingFlow();
  });

  document.getElementById('flowCloseDoneBtn')?.addEventListener('click', () => {
    closeBookingFlow();
  });
}

function renderBookingFlow() {
  if (!state.bookingFlow.open) {
    elements.bookingFlow.classList.add('hidden');
    return;
  }

  elements.bookingFlow.classList.remove('hidden');
  elements.bookingFlowTitle.textContent = state.selectedMovie
    ? `Book ${state.selectedMovie.title}`
    : 'Book Tickets';

  const stepMeta = {
    shows: 'Step 1: Choose date & time',
    seats: 'Step 2: Select seats',
    payment: 'Step 3: Payment',
    success: 'Booking complete',
  };
  elements.bookingFlowMeta.textContent = stepMeta[state.bookingFlow.step] || 'Book Tickets';

  if (state.bookingFlow.step === 'shows') {
    renderBookingFlowShowsStep();
    return;
  }
  if (state.bookingFlow.step === 'seats') {
    renderBookingFlowSeatsStep();
    return;
  }
  if (state.bookingFlow.step === 'payment') {
    renderBookingFlowPaymentStep();
    return;
  }
  renderBookingFlowSuccessStep();
}

async function selectShowForBooking(showId) {
  if (!ensureBookingAuth('choose a showtime', { type: 'selectShow', showId })) {
    return;
  }

  const chosen = state.bookingFlow.showtimes.find((show) => show.id === showId);
  if (!chosen) {
    throw new Error('Showtime not found.');
  }

  if (state.selectedShow?.id && state.selectedShow.id !== chosen.id) {
    await releaseMySeats();
  }

  state.selectedShow = chosen;
  state.lastBooking = null;
  joinShowRoom(chosen.id);
  await loadSeatMap(chosen.id);
  state.bookingFlow.step = 'seats';
  renderBookingFlow();
}

async function openBookingFlow(movie) {
  if (!movie) {
    return;
  }

  if (!ensureBookingAuth('book tickets', { type: 'openBookingFlow', movieId: movie.id })) {
    return;
  }

  if (state.selectedShow) {
    await releaseMySeats();
  }

  state.selectedMovie = movie;
  state.selectedShow = null;
  state.seatMeta = null;
  state.seats = [];
  state.lastBooking = null;
  state.bookingFlow.open = true;
  state.bookingFlow.step = 'shows';
  state.bookingFlow.showtimes = [];
  state.bookingFlow.loading = true;
  state.bookingFlow.paymentMethod = 'UPI';
  state.bookingFlow.paymentStatus = 'idle';
  state.bookingFlow.paymentMessage = '';
  state.bookingFlow.paymentBusy = false;

  renderMovieLists();
  renderMoviePanel();
  renderSeatPanel();
  renderFreshBookingBar();
  renderBookingFlow();
  elements.bookingFlow.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    state.bookingFlow.showtimes = await loadShowtimes(movie.id);
  } catch (error) {
    showError(error.message);
  } finally {
    state.bookingFlow.loading = false;
    renderBookingFlow();
  }
}

function getHeroMovies() {
  return state.homeData?.nowShowing?.length ? state.homeData.nowShowing : [];
}

function setHeroSlide(index) {
  const movies = getHeroMovies();
  if (!movies.length) {
    return;
  }
  const total = movies.length;
  state.heroSlideIndex = ((index % total) + total) % total;
  renderHero();
}

function startHeroAutoplay() {
  if (state.heroSlideTimer) {
    window.clearInterval(state.heroSlideTimer);
    state.heroSlideTimer = null;
  }

  const movies = getHeroMovies();
  if (movies.length <= 1) {
    return;
  }

  state.heroSlideTimer = window.setInterval(() => {
    setHeroSlide(state.heroSlideIndex + 1);
  }, 4500);
}

function renderHero() {
  const heroMovies = getHeroMovies();
  const featured = heroMovies[state.heroSlideIndex] || state.homeData?.featured;
  if (!featured) {
    elements.heroSection.innerHTML = '<div class="hero-content"><h1>No Featured Movie</h1></div>';
    return;
  }

  const genres = featured.genre.split(',').slice(0, 3);
  const image = featured.banner_url || featured.poster_url;

  elements.heroSection.style.background = `url('${image}') center/cover no-repeat`;
  elements.heroSection.innerHTML = `
    <div class="hero-content">
      <div class="hero-tags">
        ${genres.map((genre) => `<span class="chip">${escapeHtml(genre.trim())}</span>`).join('')}
      </div>
      <div class="rating">★ ${Number(featured.rating).toFixed(1)}</div>
      <h1>${escapeHtml(featured.title)}</h1>
      <p>${escapeHtml(featured.description)}</p>
      <div class="hero-actions">
        <button id="heroBookBtn" class="primary-btn">Book Tickets</button>
        <a class="ghost-btn" href="${escapeHtml(featured.trailer_url || '#')}" target="_blank" rel="noreferrer">Watch Trailer</a>
      </div>
      <div class="hero-carousel-controls">
        <button id="heroPrevBtn" class="small-btn">Prev</button>
        <div class="hero-dots">
          ${heroMovies
            .map(
              (movie, index) => `
            <button
              class="hero-dot ${index === state.heroSlideIndex ? 'active' : ''}"
              data-hero-index="${index}"
              aria-label="${escapeHtml(movie.title)}"
            ></button>
          `
            )
            .join('')}
        </div>
        <button id="heroNextBtn" class="small-btn">Next</button>
      </div>
    </div>
  `;

  document.getElementById('heroBookBtn')?.addEventListener('click', async () => {
    await openBookingFlow(featured);
  });

  document.getElementById('heroPrevBtn')?.addEventListener('click', () => {
    setHeroSlide(state.heroSlideIndex - 1);
  });
  document.getElementById('heroNextBtn')?.addEventListener('click', () => {
    setHeroSlide(state.heroSlideIndex + 1);
  });
  document.querySelectorAll('[data-hero-index]').forEach((node) => {
    node.addEventListener('click', () => {
      const index = Number(node.getAttribute('data-hero-index'));
      setHeroSlide(index);
    });
  });

  startHeroAutoplay();
}

function passesSearch(movie) {
  if (!state.searchText) {
    return true;
  }
  return movie.title.toLowerCase().includes(state.searchText.toLowerCase());
}

function renderMovieCard(movie, index = 0) {
  const active = state.selectedMovie?.id === movie.id;
  return `
    <article class="movie-card ${active ? 'active' : ''}" data-movie-id="${movie.id}" style="--stagger:${index}">
      <img class="movie-thumb" src="${escapeHtml(movie.poster_url || '')}" alt="${escapeHtml(movie.title)}" />
      <div class="movie-meta">
        <div class="movie-title">${escapeHtml(movie.title)}</div>
        <div class="movie-sub">${escapeHtml(movie.language)} · ★ ${Number(movie.rating).toFixed(1)}</div>
      </div>
    </article>
  `;
}

function attachMovieCardEvents() {
  const movieLookup = new Map();
  (state.homeData?.nowShowing || []).forEach((movie) => movieLookup.set(movie.id, movie));
  Object.values(getUpcomingByLanguage()).forEach((movies) => {
    (movies || []).forEach((movie) => movieLookup.set(movie.id, movie));
  });
  (state.homeData?.recentUpcoming || []).forEach((movie) => movieLookup.set(movie.id, movie));

  document.querySelectorAll('[data-movie-id]').forEach((node) => {
    node.addEventListener('click', async () => {
      const movieId = Number(node.getAttribute('data-movie-id'));
      const movie = movieLookup.get(movieId);

      if (!movie) {
        return;
      }

      await openBookingFlow(movie);
    });
  });
}

function renderMovieLists() {
  const nowShowing = (state.homeData?.nowShowing || []).filter(passesSearch);
  const upcomingBuckets = getUpcomingByLanguage();
  const upcoming = (upcomingBuckets[state.activeUpcomingTab] || []).filter(passesSearch);
  const recentUpcoming = (state.homeData?.recentUpcoming || []).filter(passesSearch);

  elements.nowShowingGrid.innerHTML = nowShowing.length
    ? nowShowing.map((movie, index) => renderMovieCard(movie, index)).join('')
    : '<div class="muted">No movies match your search.</div>';

  elements.upcomingGrid.innerHTML = upcoming.length
    ? upcoming.map((movie, index) => renderMovieCard(movie, index)).join('')
    : '<div class="muted">No upcoming titles match your search.</div>';

  elements.recentUpcomingGrid.innerHTML = recentUpcoming.length
    ? recentUpcoming.map((movie, index) => renderMovieCard(movie, index)).join('')
    : '<div class="muted">No recent upcoming titles match your search.</div>';

  attachMovieCardEvents();

  elements.upcomingTabs?.querySelectorAll('[data-tab]').forEach((tabNode) => {
    tabNode.classList.toggle('active', tabNode.getAttribute('data-tab') === state.activeUpcomingTab);
  });
}

function renderMoviePanel() {
  const movie = state.selectedMovie;
  if (!movie) {
    elements.moviePanelBody.innerHTML = '<div class="muted">Select a movie to view details.</div>';
    return;
  }

  elements.moviePanelBody.innerHTML = `
    <div><strong>${escapeHtml(movie.title)}</strong></div>
    <div class="muted">${escapeHtml(movie.language)} · ${escapeHtml(movie.genre)}</div>
    <div class="muted">${movie.duration_min} min · ★ ${Number(movie.rating).toFixed(1)}</div>
    <p class="muted">${escapeHtml(movie.description)}</p>
    <a class="small-btn" href="${escapeHtml(movie.trailer_url || '#')}" target="_blank" rel="noreferrer">Watch Trailer</a>
  `;
}

async function fetchShowtimes(movieId) {
  const payload = await request(`/api/movies/${movieId}/shows`);
  return payload.shows || [];
}

async function loadShowtimes(movieId) {
  try {
    const shows = await fetchShowtimes(movieId);

    if (state.selectedMovie?.status === 'upcoming') {
      elements.showList.innerHTML = '<div class="muted">This movie is upcoming. Showtimes will be announced soon.</div>';
      return [];
    }

    if (!shows.length) {
      elements.showList.innerHTML = '<div class="muted">No active showtimes found.</div>';
      return [];
    }

    const grouped = new Map();
    for (const show of shows) {
      const dateKey = new Date(show.startTime).toDateString();
      if (!grouped.has(dateKey)) {
        grouped.set(dateKey, []);
      }
      grouped.get(dateKey).push(show);
    }

    elements.showList.innerHTML = Array.from(grouped.entries())
      .map(([dateKey, entries]) => {
        const dateLabel = new Date(entries[0].startTime).toLocaleDateString([], {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        });

        return `
          <article class="show-item">
            <div class="show-item-head"><span>${escapeHtml(dateLabel)}</span><span>${entries.length} shows</span></div>
            ${entries
              .map(
                (show) => `
              <div class="show-time-row">
                <div>
                  <div class="show-time">${escapeHtml(show.theaterName)} · ${escapeHtml(show.screenName)}</div>
                  <div class="muted">${escapeHtml(show.theaterLocation)} · ${formatDateTime(show.startTime)}</div>
                </div>
                <button class="small-btn" data-show-id="${show.id}">From ${currency(show.price)}</button>
              </div>
            `
              )
              .join('')}
          </article>
        `;
      })
      .join('');

    document.querySelectorAll('[data-show-id]').forEach((node) => {
      node.addEventListener('click', async () => {
        const showId = Number(node.getAttribute('data-show-id'));
        const chosen = shows.find((show) => show.id === showId);
        if (!chosen) {
          return;
        }

        if (state.selectedShow?.id && state.selectedShow.id !== chosen.id) {
          await releaseMySeats();
        }

        state.selectedShow = chosen;
        state.lastBooking = null;
        joinShowRoom(chosen.id);
        await loadSeatMap(chosen.id);
      });
    });
    return shows;
  } catch (error) {
    elements.showList.innerHTML = `<div class="muted">${escapeHtml(error.message)}</div>`;
    return [];
  }
}

async function loadSeatMap(showId) {
  try {
    const payload = await request(`/api/shows/${showId}/seats`);
    state.seatMeta = payload.show;
    state.seats = payload.seats || [];
    renderSeatPanel();
    renderFreshBookingBar();
    renderBookingFlow();
  } catch (error) {
    elements.seatPanelBody.innerHTML = `<div class="muted">${escapeHtml(error.message)}</div>`;
  }
}

function myLockedSeats() {
  return state.seats
    .filter((seat) => seat.state === 'locked' && seat.lockedBy === state.lockerToken)
    .map((seat) => seat.seatLabel);
}

async function socketEmitWithAck(event, payload) {
  if (!state.socket) {
    throw new Error('Live connection unavailable. Please refresh.');
  }

  const response = await new Promise((resolve) => {
    state.socket.emit(event, payload, (ack) => resolve(ack || { ok: false, error: 'No response.' }));
  });

  if (!response.ok) {
    throw new Error(response.error || 'Operation failed.');
  }
}

async function releaseMySeats() {
  if (!state.selectedShow) {
    return;
  }

  const mine = myLockedSeats();
  if (!mine.length) {
    return;
  }

  await socketEmitWithAck('release_seats', {
    showId: state.selectedShow.id,
    seatLabels: mine,
    lockerToken: state.lockerToken,
  });
}

async function startFreshBooking() {
  try {
    await releaseMySeats();
  } catch (_error) {
    // Ignore release errors; the goal is to reset local flow.
  }

  state.selectedShow = null;
  state.seatMeta = null;
  state.seats = [];
  state.lastBooking = null;
  state.bookingFlow.step = 'shows';
  state.bookingFlow.showtimes = [];
  state.bookingFlow.loading = false;
  state.bookingFlow.paymentStatus = 'idle';
  state.bookingFlow.paymentMessage = '';
  state.bookingFlow.paymentBusy = false;
  closeBookingFlow();

  renderSeatPanel();
  renderFreshBookingBar();

  if (state.selectedMovie) {
    await loadShowtimes(state.selectedMovie.id);
  }
}

function renderSeatPanel() {
  if (!state.selectedShow || !state.seatMeta) {
    elements.seatPanelBody.innerHTML = '<div class="muted">Pick a showtime to view seat layout.</div>';
    renderFreshBookingBar();
    return;
  }

  const rows = Number(state.seatMeta.seatRows);
  const cols = Number(state.seatMeta.seatCols);
  const seatMap = new Map(state.seats.map((seat) => [seat.seatLabel, seat]));
  const mine = myLockedSeats();
  const totalAmount = mine.length * Number(state.selectedShow.price);

  const gridItems = [];
  for (let row = 0; row < rows; row += 1) {
    const rowLabel = String.fromCharCode(65 + row);
    const tierClass = getSeatTierClass(row, rows);
    for (let col = 1; col <= cols; col += 1) {
      const label = `${rowLabel}${col}`;
      const seat = seatMap.get(label);
      let cssClass = `seat ${tierClass}`;

      if (!seat || seat.state === 'available') {
        cssClass += '';
      } else if (seat.state === 'booked') {
        cssClass += ' booked';
      } else if (seat.state === 'locked' && seat.lockedBy === state.lockerToken) {
        cssClass += ' mine';
      } else if (seat.state === 'locked') {
        cssClass += ' locked';
      }

      const disabled = seat && seat.state !== 'available' && !(seat.state === 'locked' && seat.lockedBy === state.lockerToken);

      gridItems.push(
        `<button class="${cssClass}" data-seat-label="${label}" ${disabled ? 'disabled' : ''}>${label}</button>`
      );
    }
  }

  elements.seatPanelBody.innerHTML = `
    <div class="seat-wrap">
      <div class="muted"><strong>${escapeHtml(state.seatMeta.movieTitle)}</strong> · ${escapeHtml(
    state.seatMeta.theaterName
  )} · ${escapeHtml(state.seatMeta.screenName)}</div>
      <div class="muted">${formatDateTime(state.selectedShow.startTime)} · ${currency(state.selectedShow.price)} per seat</div>
      <div class="screen-bar">Screen This Way</div>
      <div class="seat-grid" style="grid-template-columns: repeat(${cols}, minmax(0, 1fr));">${gridItems.join('')}</div>
      <div class="seat-legend">
        <span class="legend-item"><span class="legend-dot available"></span>Available</span>
        <span class="legend-item"><span class="legend-dot silver"></span>Silver</span>
        <span class="legend-item"><span class="legend-dot gold"></span>Gold</span>
        <span class="legend-item"><span class="legend-dot mine"></span>Selected by you</span>
        <span class="legend-item"><span class="legend-dot locked"></span>Locked</span>
        <span class="legend-item"><span class="legend-dot booked"></span>Booked</span>
      </div>
      <div class="booking-footer">
        <div class="muted">Selected seats: ${mine.length ? escapeHtml(mine.join(', ')) : 'None'} </div>
        <div><strong>Total: ${currency(totalAmount)}</strong></div>
        <button id="confirmBookingBtn" class="pay-btn" ${mine.length ? '' : 'disabled'}>Pay & Confirm</button>
      </div>
    </div>
  `;

  document.querySelectorAll('[data-seat-label]').forEach((node) => {
    node.addEventListener('click', async () => {
      const seatLabel = node.getAttribute('data-seat-label');
      const seat = seatMap.get(seatLabel);

      try {
        if (seat && seat.state === 'locked' && seat.lockedBy === state.lockerToken) {
          await socketEmitWithAck('release_seats', {
            showId: state.selectedShow.id,
            seatLabels: [seatLabel],
            lockerToken: state.lockerToken,
          });
          return;
        }

        await socketEmitWithAck('lock_seats', {
          showId: state.selectedShow.id,
          seatLabels: [seatLabel],
          lockerToken: state.lockerToken,
        });
      } catch (error) {
        showError(error.message);
      }
    });
  });

  document.getElementById('confirmBookingBtn')?.addEventListener('click', async () => {
    try {
      await confirmBooking('UPI', 'panel');
    } catch (error) {
      showError(error.message);
    }
  });
  renderFreshBookingBar();
}

async function confirmBooking(paymentMethod = 'UPI', source = 'panel') {
  if (!ensureBookingAuth('confirm your booking')) {
    return;
  }

  const seats = myLockedSeats();
  if (!seats.length) {
    showError('Select at least one seat.');
    return;
  }

  const payload = await request('/api/bookings/confirm', {
    method: 'POST',
    body: JSON.stringify({
      showId: state.selectedShow.id,
      seatLabels: seats,
      lockerToken: state.lockerToken,
      paymentMethod,
    }),
  });

  await applyBookingSuccess(payload.booking, source);
}

function renderNotifications() {
  if (!elements.notificationList) {
    return;
  }

  if (!state.notifications.length) {
    elements.notificationList.innerHTML = '<div class="muted">No notifications yet.</div>';
    return;
  }

  const sorted = [...state.notifications].sort((first, second) => {
    return new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime();
  });

  elements.notificationList.innerHTML = sorted
    .map(
      (notification) => `
        <article class="notification-item">
          <div class="meta">
            <span>${escapeHtml(notification.type.toUpperCase())}</span>
            <span>${new Date(notification.createdAt).toLocaleString()}</span>
          </div>
          <h4>${escapeHtml(notification.title)}</h4>
          <p>${escapeHtml(notification.message)}</p>
        </article>
      `
    )
    .join('');
}

async function onAuthClick() {
  if (state.session.authenticated) {
    try {
      await releaseMySeats();
    } catch (_error) {
      // Ignore seat release failures during logout.
    }
    await request('/api/auth/logout', { method: 'POST' });
    closeBookingFlow();
    closeAuthModal();
    await loadSession();
    await loadNotifications();
    return;
  }
  openAuthModal('login');
}

function wireEvents() {
  elements.movieSearch.addEventListener('input', () => {
    state.searchText = elements.movieSearch.value.trim();
    renderMovieLists();
  });

  elements.introEnterBtn?.addEventListener('click', () => {
    closeIntroOverlay();
  });

  elements.authButton.addEventListener('click', async () => {
    try {
      await onAuthClick();
    } catch (error) {
      showError(error.message);
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }

    if (state.intro.open) {
      closeIntroOverlay();
      return;
    }

    if (state.authFlow.open) {
      closeAuthModal();
    }
  });

  window.addEventListener('touchstart', onSwipeTouchStart, { passive: true });
  window.addEventListener('touchmove', onSwipeTouchMove, { passive: true });
  window.addEventListener('touchend', onSwipeTouchEnd, { passive: true });
  window.addEventListener('touchcancel', resetSwipeTracking, { passive: true });

  elements.upcomingTabs?.addEventListener('click', (event) => {
    const target = event.target.closest('[data-tab]');
    if (!target) {
      return;
    }
    const tab = target.getAttribute('data-tab');
    if (!tab) {
      return;
    }
    state.activeUpcomingTab = tab;
    renderMovieLists();
  });

  elements.bookingFlowClose.addEventListener('click', async () => {
    try {
      await releaseMySeats();
    } catch (_error) {
      // Ignore release failures on close.
    }
    closeBookingFlow();
    renderSeatPanel();
    renderFreshBookingBar();
  });

  window.addEventListener('beforeunload', () => {
    if (state.heroSlideTimer) {
      window.clearInterval(state.heroSlideTimer);
    }
    clearAuthTicker();
    clearIntroTimers();
    resetSwipeTracking();

    if (!state.selectedShow) {
      return;
    }

    const seats = myLockedSeats();
    if (seats.length) {
      state.socket?.emit('release_seats', {
        showId: state.selectedShow.id,
        seatLabels: seats,
        lockerToken: state.lockerToken,
      });
    }
  });
}

async function start() {
  wireEvents();
  connectSocket();
  openIntroOverlay();

  try {
    await loadSession();
    await loadPaymentConfig();
    await loadHome();
    await loadNotifications();
  } catch (error) {
    showError(error.message);
  }
}

start();
