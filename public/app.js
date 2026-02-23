const state = {
  homeData: null,
  selectedMovie: null,
  selectedShow: null,
  seatMeta: null,
  seats: [],
  lastBooking: null,
  bookingFlow: {
    open: false,
    step: 'shows',
    showtimes: [],
    loading: false,
    paymentMethod: 'UPI',
  },
  activeUpcomingTab: 'telugu',
  searchText: '',
  lockerToken: getOrCreateLockerToken(),
  session: {
    authenticated: false,
    user: null,
    googleEnabled: false,
  },
  socket: null,
  notifications: [],
};

const elements = {
  heroSection: document.getElementById('heroSection'),
  nowShowingGrid: document.getElementById('nowShowingGrid'),
  upcomingGrid: document.getElementById('upcomingGrid'),
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
  movieSearch: document.getElementById('movieSearch'),
  authButton: document.getElementById('authButton'),
  teluguTab: document.getElementById('teluguTab'),
  hindiTab: document.getElementById('hindiTab'),
};

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
}

async function loadHome() {
  const data = await request('/api/home');
  state.homeData = data;

  if (!state.selectedMovie && data.featured) {
    state.selectedMovie = data.featured;
  }

  renderHero();
  renderMovieLists();
  renderMoviePanel();
  renderFreshBookingBar();

  if (state.selectedMovie) {
    await loadShowtimes(state.selectedMovie.id);
  }
}

async function loadNotifications() {
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
    elements.authButton.textContent = `Sign Out · ${state.session.user.name}`;
    return;
  }
  elements.authButton.textContent = 'Sign In';
}

function renderFreshBookingBar() {
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
    for (let col = 1; col <= cols; col += 1) {
      const label = `${rowLabel}${col}`;
      const seat = seatMap.get(label);
      let cssClass = 'seat';

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
    renderBookingFlow();
  });
}

function renderBookingFlowPaymentStep() {
  const selectedSeats = myLockedSeats();
  if (!state.selectedShow || !selectedSeats.length) {
    elements.bookingFlowBody.innerHTML = '<div class="muted">Select seats before payment.</div>';
    return;
  }

  const totalAmount = selectedSeats.length * Number(state.selectedShow.price);
  const options = ['UPI', 'CRYPTO', 'NET_BANKING'];
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
    <div class="flow-footer">
      <button id="flowBackToSeatsBtn" class="small-btn">Back to Seats</button>
      <button id="flowPayNowBtn" class="pay-btn">Pay Now (${escapeHtml(
        state.bookingFlow.paymentMethod === 'NET_BANKING' ? 'Net Banking' : state.bookingFlow.paymentMethod
      )})</button>
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
      await confirmBooking(state.bookingFlow.paymentMethod, 'flow');
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

function renderHero() {
  const featured = state.homeData?.featured;
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
    </div>
  `;

  document.getElementById('heroBookBtn')?.addEventListener('click', async () => {
    await openBookingFlow(featured);
  });
}

function passesSearch(movie) {
  if (!state.searchText) {
    return true;
  }
  return movie.title.toLowerCase().includes(state.searchText.toLowerCase());
}

function renderMovieCard(movie) {
  const active = state.selectedMovie?.id === movie.id;
  return `
    <article class="movie-card ${active ? 'active' : ''}" data-movie-id="${movie.id}">
      <img class="movie-thumb" src="${escapeHtml(movie.poster_url || '')}" alt="${escapeHtml(movie.title)}" />
      <div class="movie-meta">
        <div class="movie-title">${escapeHtml(movie.title)}</div>
        <div class="movie-sub">${escapeHtml(movie.language)} · ★ ${Number(movie.rating).toFixed(1)}</div>
      </div>
    </article>
  `;
}

function attachMovieCardEvents() {
  document.querySelectorAll('[data-movie-id]').forEach((node) => {
    node.addEventListener('click', async () => {
      const movieId = Number(node.getAttribute('data-movie-id'));
      const movie =
        state.homeData.nowShowing.find((item) => item.id === movieId) ||
        state.homeData.upcomingTelugu.find((item) => item.id === movieId) ||
        state.homeData.upcomingHindi.find((item) => item.id === movieId);

      if (!movie) {
        return;
      }

      await openBookingFlow(movie);
    });
  });
}

function renderMovieLists() {
  const nowShowing = (state.homeData?.nowShowing || []).filter(passesSearch);
  const upcoming =
    state.activeUpcomingTab === 'telugu'
      ? (state.homeData?.upcomingTelugu || []).filter(passesSearch)
      : (state.homeData?.upcomingHindi || []).filter(passesSearch);

  elements.nowShowingGrid.innerHTML = nowShowing.length
    ? nowShowing.map(renderMovieCard).join('')
    : '<div class="muted">No movies match your search.</div>';

  elements.upcomingGrid.innerHTML = upcoming.length
    ? upcoming.map(renderMovieCard).join('')
    : '<div class="muted">No upcoming titles match your search.</div>';

  attachMovieCardEvents();

  elements.teluguTab.classList.toggle('active', state.activeUpcomingTab === 'telugu');
  elements.hindiTab.classList.toggle('active', state.activeUpcomingTab === 'hindi');
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
    for (let col = 1; col <= cols; col += 1) {
      const label = `${rowLabel}${col}`;
      const seat = seatMap.get(label);
      let cssClass = 'seat';

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

  state.lastBooking = payload.booking;
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
    renderBookingFlow();
  }

  await loadNotifications();
}

function renderNotifications() {
  if (!state.notifications.length) {
    elements.notificationList.innerHTML = '<div class="muted">No notifications yet.</div>';
    return;
  }

  elements.notificationList.innerHTML = state.notifications
    .map(
      (notification) => `
        <article class="notification-item">
          <div class="meta">
            <span>${escapeHtml(notification.type.toUpperCase())}</span>
            <span>${new Date(notification.createdAt).toLocaleDateString()}</span>
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
    await request('/api/auth/logout', { method: 'POST' });
    await loadSession();
    await loadNotifications();
    return;
  }

  if (state.session.googleEnabled) {
    window.location.href = '/auth/google';
    return;
  }

  const name = window.prompt('Google OAuth is not configured. Enter your name for demo login:');
  if (!name) {
    return;
  }

  await request('/api/auth/dev-login', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });

  await loadSession();
  await loadNotifications();
}

function wireEvents() {
  elements.movieSearch.addEventListener('input', () => {
    state.searchText = elements.movieSearch.value.trim();
    renderMovieLists();
  });

  elements.authButton.addEventListener('click', async () => {
    try {
      await onAuthClick();
    } catch (error) {
      showError(error.message);
    }
  });

  elements.teluguTab.addEventListener('click', () => {
    state.activeUpcomingTab = 'telugu';
    renderMovieLists();
  });

  elements.hindiTab.addEventListener('click', () => {
    state.activeUpcomingTab = 'hindi';
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

  try {
    await loadSession();
    await loadHome();
    await loadNotifications();
  } catch (error) {
    showError(error.message);
  }
}

start();
