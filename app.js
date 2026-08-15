(() => {
  const STORAGE_KEY = "holdings-v2";
  const DEFAULTS = {
    symbol: "SNAP",
    shares: 130000,
    assets: 3530000,
    target: 5000000,
    distribution: 0.04,
  };

  const els = {
    fill: document.getElementById("fill"),
    value: document.getElementById("value"),
    dist: document.getElementById("dist"),
    story: document.getElementById("story"),
    gear: document.getElementById("gear"),
    scrim: document.getElementById("scrim"),
    panel: document.getElementById("panel"),
    symbol: document.getElementById("symbol"),
    shares: document.getElementById("shares"),
    assets: document.getElementById("assets"),
    target: document.getElementById("target"),
    distribution: document.getElementById("distribution"),
    slider: document.getElementById("price-slider"),
    slideNow: document.getElementById("slide-now"),
    market: document.getElementById("market"),
    marketLabel: document.getElementById("market-label"),
  };

  const SLIDER_MAX = 26.37;
  let sliding = false;
  let sliderPrice = null;

  /** @type {{symbol?:string, price:number|null, change:number|null, time:Date|null}|null} */
  let quote = null;

  const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

  function readCookie(name) {
    const parts = document.cookie.split("; ");
    for (const part of parts) {
      if (part.startsWith(name + "=")) {
        return decodeURIComponent(part.slice(name.length + 1));
      }
    }
    return "";
  }

  function writeCookie(name, value) {
    document.cookie =
      name +
      "=" +
      encodeURIComponent(value) +
      "; Max-Age=" +
      COOKIE_MAX_AGE +
      "; Path=/; SameSite=Lax";
  }

  function parseSettings(raw) {
    const parsed = JSON.parse(raw);
    return {
      symbol: String(parsed.symbol || DEFAULTS.symbol).toUpperCase(),
      shares: Number(parsed.shares) > 0 ? Number(parsed.shares) : DEFAULTS.shares,
      assets: Number(parsed.assets) >= 0 ? Number(parsed.assets) : DEFAULTS.assets,
      target: Number(parsed.target) > 0 ? Number(parsed.target) : DEFAULTS.target,
      distribution: normalizeRate(parsed.distribution),
    };
  }

  function loadSettings() {
    try {
      const fromCookie = readCookie(STORAGE_KEY);
      if (fromCookie) return parseSettings(fromCookie);
      const fromLocal = localStorage.getItem(STORAGE_KEY);
      if (fromLocal) {
        const cfg = parseSettings(fromLocal);
        persist(cfg);
        return cfg;
      }
    } catch {
      /* use defaults */
    }
    return { ...DEFAULTS };
  }

  function readForm() {
    return {
      symbol: (els.symbol.value || DEFAULTS.symbol).trim().toUpperCase() || DEFAULTS.symbol,
      shares: Math.max(0, Number(els.shares.value) || 0),
      assets: Math.max(0, Number(els.assets.value) || 0),
      target: Math.max(1, Number(els.target.value) || DEFAULTS.target),
      distribution: normalizeRate(els.distribution.value),
    };
  }

  function normalizeRate(raw) {
    let n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULTS.distribution;
    if (n > 1) n = n / 100;
    return n;
  }

  function persist(cfg) {
    const payload = JSON.stringify(cfg);
    writeCookie(STORAGE_KEY, payload);
    try {
      localStorage.setItem(STORAGE_KEY, payload);
    } catch {
      /* cookie is the source of truth */
    }
  }

  function compactMoney(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const abs = Math.abs(n);
    const sign = n < 0 ? "−" : "";
    if (abs >= 1e6) {
      const m = abs / 1e6;
      const digits = m >= 10 ? 1 : 2;
      return sign + "$" + m.toFixed(digits).replace(/\.0$/, "") + "M";
    }
    if (abs >= 1e3) {
      const k = abs / 1e3;
      const digits = k >= 100 ? 0 : 1;
      return sign + "$" + k.toFixed(digits).replace(/\.0$/, "") + "K";
    }
    return (
      sign +
      "$" +
      Math.round(abs).toLocaleString("en-US")
    );
  }

  function compactK(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const k = Math.abs(n) / 1e3;
    const digits = k >= 100 ? 0 : 1;
    return (n < 0 ? "−" : "") + "$" + k.toFixed(digits).replace(/\.0$/, "") + "K";
  }

  function slimPrice(n) {
    if (n == null || Number.isNaN(n) || !Number.isFinite(n)) return "—";
    const abs = Math.abs(n);
    const formatted = abs.toFixed(2).replace(/\.?0+$/, "");
    const body = formatted.includes(".") ? formatted : abs.toFixed(1);
    return (n < 0 ? "−" : "") + body;
  }

  function clock(date) {
    if (!date) return "";
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
  }

  /** NYSE regular session: Mon–Fri 9:30–16:00 America/New_York */
  function isNyseOpen(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const weekday = get("weekday");
    if (weekday === "Sat" || weekday === "Sun") return false;
    let hour = Number(get("hour"));
    const minute = Number(get("minute"));
    // Some engines emit "24" for midnight
    if (hour === 24) hour = 0;
    const mins = hour * 60 + minute;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  }

  function updateMarketBadge() {
    const open = isNyseOpen();
    if (!els.market || !els.marketLabel) return open;
    els.market.classList.toggle("is-open", open);
    els.market.classList.toggle("is-closed", !open);
    els.marketLabel.textContent = open ? "NYSE open" : "NYSE closed";
    els.market.setAttribute("aria-label", open ? "NYSE is open" : "NYSE is closed");
    return open;
  }

  function yahooUrl(symbol) {
    return (
      "https://query2.finance.yahoo.com/v8/finance/chart/" +
      encodeURIComponent(symbol) +
      "?interval=5m&range=1d&includePrePost=false"
    );
  }

  async function fetchJson(url) {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function loadYahoo(symbol) {
    const url = yahooUrl(symbol);
    const enc = encodeURIComponent(url);
    const attempts = [
      async () => fetchJson(url),
      async () => {
        const j = await fetchJson("https://api.allorigins.win/get?url=" + enc);
        if (!j.contents) throw new Error("empty proxy");
        return JSON.parse(j.contents);
      },
      async () => fetchJson("https://corsproxy.io/?" + enc),
      async () =>
        fetchJson("https://api.codetabs.com/v1/proxy/?quest=" + encodeURIComponent(url)),
    ];

    let lastErr;
    for (const attempt of attempts) {
      try {
        const data = await attempt();
        const result = data?.chart?.result?.[0];
        if (!result?.meta) throw new Error("bad payload");
        return result;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("All quote sources failed");
  }

  function parseQuote(result) {
    const meta = result.meta;
    const quoteData = result.indicators?.quote?.[0] || {};
    const closes = (quoteData.close || []).filter((v) => v != null);
    const price = meta.regularMarketPrice ?? closes[closes.length - 1];
    const prev = meta.chartPreviousClose ?? meta.previousClose;
    const change = price != null && prev != null ? price - prev : null;
    return {
      symbol: meta.symbol,
      price,
      change,
      time: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000) : new Date(),
    };
  }

  function render() {
    const { shares, assets, target, symbol, distribution } = loadSettings();
    const livePrice = quote?.price ?? null;
    const price = sliderPrice != null ? sliderPrice : livePrice;
    const stockValue = price != null ? price * shares : null;
    const value = stockValue != null ? stockValue + assets : null;
    const pct = value != null && target > 0 ? Math.min(100, (value / target) * 100) : 0;
    const neededFromStock = target - assets;
    const goalPrice = shares > 0 ? neededFromStock / shares : null;
    const yearly = value != null ? value * distribution : null;

    els.value.textContent = compactMoney(value);
    els.dist.textContent = yearly == null ? "" : compactMoney(yearly);

    if (!quote || quote.price == null) {
      els.story.textContent = "";
    } else {
      const direction =
        (quote.change ?? 0) > 0.004 ? "up" : (quote.change ?? 0) < -0.004 ? "down" : "unchanged";
      const moveWord = direction === "up" ? "up " : "down ";
      const move =
        quote.change == null
          ? ""
          : direction === "unchanged"
            ? "flat"
            : moveWord + "<strong>" + slimPrice(Math.abs(quote.change)) + "</strong>";
      const asOf = quote.time ? " as of <strong>" + clock(quote.time) + "</strong>" : "";
      const first =
        symbol +
        " is " +
        direction +
        ". Trading at <strong>" +
        slimPrice(quote.price) +
        "</strong>" +
        (move ? ", " + move + " for today" : "") +
        asOf +
        ". The " +
        symbol +
        " holding is valued at <strong>" +
        compactK(stockValue) +
        "</strong>.";
      let second;
      if (goalPrice == null) {
        second = "";
      } else if (neededFromStock <= 0) {
        second =
          " You've already reached your target of <strong>" +
          compactMoney(target).replace("$", "") +
          "</strong>.";
      } else {
        second =
          " When " +
          symbol +
          " gets to <strong>" +
          slimPrice(goalPrice) +
          "</strong> you will reach your target of <strong>" +
          compactMoney(target).replace("$", "") +
          "</strong>.";
      }
      els.story.innerHTML = first + second;
    }

    els.fill.style.height = pct + "%";
    els.fill.classList.toggle("is-done", pct >= 100);
    document.title = compactMoney(value);

    if (els.slider && !sliding && livePrice != null) {
      els.slider.value = String(Math.min(SLIDER_MAX, Math.max(0, livePrice)));
      sliderPrice = Number(els.slider.value);
    }
    if (els.slideNow) {
      const shown = sliderPrice != null ? sliderPrice : livePrice;
      els.slideNow.textContent = shown == null ? "" : slimPrice(shown);
      positionBubble();
    }
  }

  function positionBubble() {
    const slider = els.slider;
    const bubble = els.slideNow;
    if (!slider || !bubble) return;
    const min = Number(slider.min);
    const max = Number(slider.max);
    const val = Number(slider.value);
    const pct = max === min ? 0 : (val - min) / (max - min);
    const thumb = 28;
    const x = pct * (slider.clientWidth - thumb) + thumb / 2;
    bubble.style.left = x + "px";
  }

  async function refresh() {
    const initial = !quote;
    const started = Date.now();
    if (initial) document.body.classList.remove("is-ready");
    try {
      quote = parseQuote(await loadYahoo(loadSettings().symbol));
      if (quote.symbol) {
        const cfg = loadSettings();
        cfg.symbol = quote.symbol;
        persist(cfg);
        els.symbol.value = quote.symbol;
      }
      if (quote.price != null && !sliding) {
        sliderPrice = Math.min(SLIDER_MAX, Math.max(0, quote.price));
        els.slider.value = String(sliderPrice);
      }
      render();
    } catch (err) {
      els.story.textContent = "Could not load quote";
      console.error(err);
    } finally {
      const wait = initial ? Math.max(0, 700 - (Date.now() - started)) : 0;
      window.setTimeout(() => {
        document.body.classList.add("is-ready");
        positionBubble();
      }, wait);
    }
  }

  function openSettings() {
    const cfg = loadSettings();
    els.symbol.value = cfg.symbol;
    els.shares.value = String(cfg.shares);
    els.assets.value = String(cfg.assets);
    els.target.value = String(cfg.target);
    els.distribution.value = String(cfg.distribution);
    els.scrim.hidden = false;
    els.symbol.focus();
  }

  function closeSettings(save) {
    if (save) {
      const next = readForm();
      const prev = loadSettings();
      persist(next);
      if (next.symbol !== prev.symbol) refresh();
      else render();
    }
    els.scrim.hidden = true;
  }

  const saved = loadSettings();
  els.symbol.value = saved.symbol;
  els.shares.value = String(saved.shares);
  els.assets.value = String(saved.assets);
  els.target.value = String(saved.target);
  els.distribution.value = String(saved.distribution);
  els.slider.max = String(SLIDER_MAX);

  els.slider.addEventListener("pointerdown", () => {
    sliding = true;
  });
  window.addEventListener("pointerup", () => {
    sliding = false;
  });
  els.slider.addEventListener("input", () => {
    sliding = true;
    sliderPrice = Number(els.slider.value);
    render();
  });
  window.addEventListener("resize", positionBubble);

  render();

  els.gear.addEventListener("click", openSettings);
  els.scrim.addEventListener("click", (e) => {
    if (e.target === els.scrim) closeSettings(true);
  });
  els.panel.addEventListener("submit", (e) => {
    e.preventDefault();
    closeSettings(true);
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.scrim.hidden) closeSettings(true);
  });

  updateMarketBadge();
  refresh();

  setInterval(() => {
    const open = updateMarketBadge();
    if (open) refresh();
  }, 60_000);
})();
