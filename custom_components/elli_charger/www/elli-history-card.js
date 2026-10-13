/*
 * Elli Charger - history card (custom:elli-history-card)
 * Grafana-style year -> month overview of the "Energy History" sensor.
 *
 * Shipped with the elli_charger integration and auto-loaded into every
 * dashboard - no separate resource or HACS frontend install needed.
 *
 * Minimal config:
 *   type: custom:elli-history-card
 *
 * All options:
 *   entity: sensor.xxx_energy_history   # auto-detected if omitted
 *   title: Wallbox · Ladehistorie
 *   price_per_kwh: 0.32                 # optional, shows costs
 *   currency: "€"
 *   compare: true                       # previous year as ghost bars
 *   theme: dark                         # dark (Grafana) | ha (follow HA theme)
 *   card_names:                         # optional: rename RFID cards
 *     "RFID 04A1B2C3": Markus
 *   show_live: true                     # live header while a car is plugged in
 *   show_recent: true                   # table of the last charges
 *   recent_count: 10                    # how many of them (max. 10)
 *   show_projection: true               # year-end projection for the current year
 *   show_solar: true                    # solar share (needs a PV sensor in the
 *                                       # integration's options)
 */

const CARD_VERSION = "1.6.0";
const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const MONTHS_LONG = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

const fmt = (v, d = 1) =>
  Number(v || 0).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const pad2 = (n) => String(n).padStart(2, "0");
function fmtDur(minutes) {
  const m = Math.max(0, Math.round(minutes || 0));
  return `${Math.floor(m / 60)}:${pad2(m % 60)} h`;
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "–";
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const pct = (part, whole) => (whole > 0 ? Math.min(100, (part / whole) * 100) : 0);

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return m * p;
}

function findHistoryEntity(hass) {
  if (!hass) return null;
  return (
    Object.keys(hass.states).find(
      (id) => id.startsWith("sensor.") && Array.isArray(hass.states[id].attributes.years)
    ) || null
  );
}

const STYLE = `
<style>
  :host {
    --g-bg: #181b1f; --g-bg2: #111217; --g-border: #2c3235; --g-text: #ccccdc;
    --g-muted: #8e8e9e; --g-grid: #2c3235; --g-green: #73bf69; --g-blue: #5794f2;
    --g-red: #f2495c; --g-yellow: #fade2a; --g-hover: #22252b;
    display: block;
  }
  :host(.ha-theme) {
    --g-bg: var(--ha-card-background, var(--card-background-color));
    --g-bg2: var(--secondary-background-color); --g-border: var(--divider-color);
    --g-text: var(--primary-text-color); --g-muted: var(--secondary-text-color);
    --g-grid: var(--divider-color); --g-hover: var(--secondary-background-color);
  }
  ha-card { background: var(--g-bg); border: 1px solid var(--g-border); border-radius: 6px;
    color: var(--g-text); font-family: Inter, Roboto, "Helvetica Neue", Arial, sans-serif; overflow: hidden; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 10px 14px; border-bottom: 1px solid var(--g-border); flex-wrap: wrap; }
  .title { font-size: 14px; font-weight: 500; letter-spacing: .2px; display: flex; align-items: center; gap: 8px; }
  .title .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--g-green); box-shadow: 0 0 6px var(--g-green); }
  .chips { display: flex; gap: 4px; flex-wrap: wrap; }
  .chip { font-size: 12px; padding: 3px 10px; border-radius: 3px; border: 1px solid var(--g-border);
    background: var(--g-bg2); color: var(--g-muted); cursor: pointer; user-select: none; }
  .chip:hover { color: var(--g-text); }
  .chip.on { background: var(--g-blue); border-color: var(--g-blue); color: #fff; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; padding: 12px 14px 4px; }
  .stat { background: var(--g-bg2); border: 1px solid var(--g-border); border-radius: 4px; padding: 8px 10px; }
  .stat .l { font-size: 11px; color: var(--g-muted); text-transform: uppercase; letter-spacing: .5px; }
  .stat .v { font-size: 22px; font-weight: 500; margin-top: 2px; white-space: nowrap; }
  .stat .v small { font-size: 12px; color: var(--g-muted); font-weight: 400; margin-left: 2px; }
  .stat .d { font-size: 11px; margin-top: 2px; color: var(--g-muted); }
  .up { color: var(--g-red); } .down { color: var(--g-green); }
  .section { padding: 8px 14px 4px; font-size: 12px; color: var(--g-muted); display: flex;
    justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 4px 12px; }
  .legend { display: flex; gap: 4px 12px; flex-wrap: wrap; }
  .legend span { white-space: nowrap; }
  .legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 2px;
    margin-right: 5px; vertical-align: -1px; background: var(--g-green); }
  .legend span.prev::before { background: var(--g-blue); opacity: .45; }
  .chart { position: relative; padding: 0 8px 4px; }
  .chart svg { width: 100%; height: auto; display: block; }
  .chart text { fill: var(--g-muted); font-size: 10px; font-family: inherit; }
  .chart text.val { fill: var(--g-text); }
  .chart .gl { stroke: var(--g-grid); stroke-width: 1; stroke-dasharray: 2 3; }
  .chart .hit { fill: transparent; cursor: crosshair; }
  .chart .hit:hover { fill: rgba(255,255,255,0.04); }
  .tip { position: absolute; pointer-events: none; background: var(--g-bg2); border: 1px solid var(--g-border);
    border-radius: 4px; padding: 8px 10px; font-size: 12px; min-width: 150px; box-shadow: 0 4px 14px rgba(0,0,0,.45);
    display: none; z-index: 2; }
  .tip b { display: block; margin-bottom: 4px; }
  .tip .r { display: flex; justify-content: space-between; gap: 14px; }
  .tip .r span:first-child { color: var(--g-muted); }
  .tip hr { border: none; border-top: 1px solid var(--g-border); margin: 5px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .tbl { padding: 4px 14px 12px; }
  th { text-align: left; font-weight: 500; color: var(--g-muted); font-size: 11px; text-transform: uppercase;
    letter-spacing: .5px; padding: 6px 6px; border-bottom: 1px solid var(--g-border); }
  th.n, td.n { text-align: right; white-space: nowrap; }
  td { padding: 6px; border-bottom: 1px solid var(--g-border); vertical-align: middle; }
  tr.year { cursor: pointer; }
  tr.year:hover td, tr.month:hover td { background: var(--g-hover); }
  tr.year.sel td:first-child { box-shadow: inset 3px 0 0 var(--g-blue); }
  tr.year td.y { font-weight: 500; white-space: nowrap; }
  .caret { display: inline-block; width: 12px; color: var(--g-muted); transition: transform .15s; }
  .caret.open { transform: rotate(90deg); }
  tr.month td { font-size: 12px; background: var(--g-bg2); }
  tr.month td.m { padding-left: 26px; white-space: nowrap; }
  .gauge { height: 14px; background: rgba(255,255,255,.04); border-radius: 2px; overflow: hidden; min-width: 60px; }
  .gauge div { height: 100%; background: linear-gradient(90deg, var(--g-green), #37872d);
    border-radius: 2px; }
  .cards { color: var(--g-muted); font-size: 11px; }
  .spark { display: block; }
  .spark rect { fill: var(--g-green); }
  .live { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 12px 14px 0;
    padding: 9px 12px; border-radius: 4px; border: 1px solid var(--g-border); background: var(--g-bg2); font-size: 13px; }
  .live.on { border-color: var(--g-green); box-shadow: inset 3px 0 0 var(--g-green); }
  .live .pulse { width: 9px; height: 9px; border-radius: 50%; background: var(--g-blue); flex: none; }
  .live.on .pulse { background: var(--g-green); animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(115,191,105,.6); } 50% { box-shadow: 0 0 0 6px rgba(115,191,105,0); } }
  .live .ls { font-weight: 500; }
  .live .lp { color: var(--g-muted); }
  .live .lp b { color: var(--g-text); font-weight: 500; }
  .sun { color: var(--g-yellow); }
  .legend span.sol::before { background: var(--g-yellow); }
  .proj { color: var(--g-muted); }
  .empty { padding: 24px 16px; color: var(--g-muted); font-size: 13px; text-align: center; }
  .foot { padding: 0 14px 10px; font-size: 10px; color: var(--g-muted); text-align: right; }
  @media (max-width: 480px) { .hide-s { display: none; } .stat .v { font-size: 18px; } }
</style>`;

class ElliHistoryCard extends HTMLElement {
  setConfig(config) {
    this._config = { compare: true, currency: "€", theme: "dark", title: "Wallbox · Ladehistorie", ...config };
    this._selected = null;
    this._expanded = this._expanded || new Set();
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this._bindEvents();
    }
    this.classList.toggle("ha-theme", this._config.theme === "ha");
    this._sig = null;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    const st = this._stateObj();
    const sig = st ? `${st.entity_id}|${st.last_updated}` : "none";
    if (sig !== this._sig) {
      this._sig = sig;
      this._render();
    }
    this._syncTimer();
  }

  connectedCallback() {
    this._syncTimer();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._timer = null;
  }

  // Keep the live header's "since" duration ticking while a car is plugged in.
  _syncTimer() {
    const lv = this._stateObj()?.attributes?.live;
    const active = this.isConnected && lv && lv.status && lv.status !== "idle" && this._config?.show_live !== false;
    if (active && !this._timer) {
      this._timer = setInterval(() => this._render(), 60000);
    } else if (!active && this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _showSolar() {
    return this._config.show_solar !== false;
  }

  _liveHtml(st) {
    const lv = st.attributes.live;
    if (this._config.show_live === false || !lv || !lv.status || lv.status === "idle") return "";
    const charging = lv.status === "charging";
    const parts = [];
    if (charging) parts.push(`<b>${fmt((lv.power_w || 0) / 1000, 1)} kW</b>`);
    if (lv.energy_kwh != null) parts.push(`<b>${fmt(lv.energy_kwh, 1)} kWh</b>`);
    if (lv.start) parts.push(`seit ${fmtDur((Date.now() - Date.parse(lv.start)) / 60000)}`);
    const cost = lv.energy_kwh != null ? this._cost(lv.energy_kwh) : null;
    if (cost) parts.push(cost);
    if (lv.card) parts.push(esc(this._cardName(lv.card)));
    return `<div class="live ${charging ? "on" : ""}"><span class="pulse"></span>
      <span class="ls">${charging ? "Lädt gerade" : "Auto verbunden"}</span><span class="lp">${parts.join(" · ")}</span></div>`;
  }

  // Linear year-end projection for the current year (from the first month
  // with data in the wallbox's first year). Null if there's too little data.
  _projection(sel, firstYear) {
    const now = new Date();
    if (this._config.show_projection === false || sel.year !== now.getFullYear()) return null;
    let start = new Date(sel.year, 0, 1);
    if (sel.year === firstYear) {
      const idx = sel.months.findIndex((m) => m.kwh > 0);
      if (idx > 0) start = new Date(sel.year, idx, 1);
    }
    const days = (now - start) / 864e5;
    if (days < 14 || sel.kwh <= 0) return null;
    const total = (new Date(sel.year + 1, 0, 1) - start) / 864e5;
    return sel.kwh * (total / days);
  }

  _recentHtml(st) {
    const list = st.attributes.recent_charges;
    if (this._config.show_recent === false || !Array.isArray(list) || !list.length) return "";
    const count = Math.max(1, Math.min(10, Number(this._config.recent_count) || 10));
    const hasCost = Number(this._config.price_per_kwh) > 0;
    const hasSolar = this._showSolar() && list.some((c) => c.solar_kwh != null);
    let h = `<div class="section"><span>Letzte Ladungen</span></div><div class="tbl"><table><thead><tr>
      <th>Start</th><th class="n">Dauer</th><th class="n">kWh</th><th class="n hide-s">Ø kW</th><th class="hide-s">Karte</th>
      ${hasCost ? `<th class="n">Kosten</th>` : ""}${hasSolar ? `<th class="n">Sonne</th>` : ""}</tr></thead><tbody>`;
    for (const c of list.slice(0, count)) {
      h += `<tr><td>${fmtDateTime(c.start)}</td>
        <td class="n">${c.minutes != null ? fmtDur(c.minutes) : "–"}</td>
        <td class="n">${fmt(c.kwh, 1)}</td>
        <td class="n hide-s">${c.avg_kw != null ? fmt(c.avg_kw, 1) : "–"}</td>
        <td class="hide-s cards">${esc(this._cardName(c.card || ""))}</td>
        ${hasCost ? `<td class="n">${this._cost(c.kwh)}</td>` : ""}
        ${hasSolar ? `<td class="n sun">${c.solar_kwh != null ? `≤ ${fmt(pct(c.solar_kwh, c.kwh), 0)} %` : "–"}</td>` : ""}</tr>`;
    }
    return h + "</tbody></table></div>";
  }

  getCardSize() {
    return 9;
  }

  static getStubConfig(hass) {
    return { entity: findHistoryEntity(hass) || "", title: "Wallbox · Ladehistorie" };
  }

  _stateObj() {
    if (!this._hass || !this._config) return null;
    const id = this._config.entity || findHistoryEntity(this._hass);
    return id ? this._hass.states[id] || null : null;
  }

  _cardName(label) {
    const map = this._config.card_names || {};
    return map[label] || map[String(label).replace(/^RFID\s+/, "")] || label;
  }

  _cost(kwh) {
    const p = Number(this._config.price_per_kwh);
    return p > 0 ? `${fmt(kwh * p, 2)} ${esc(this._config.currency)}` : null;
  }

  _years() {
    const st = this._stateObj();
    if (!st || !Array.isArray(st.attributes.years)) return null;
    return st.attributes.years.slice().sort((a, b) => b.year - a.year);
  }

  // ---------------------------------------------------------------- render
  _render() {
    if (!this.shadowRoot || !this._config) return;
    const st = this._stateObj();
    const years = this._years();
    const head = (chips = "") => `
      <div class="head"><div class="title"><span class="dot"></span>${esc(this._config.title)}</div>
      <div class="chips">${chips}</div></div>`;

    if (!st || !years) {
      this.shadowRoot.innerHTML = `${STYLE}<ha-card>${head()}<div class="empty">
        Kein „Energy History“-Sensor der Elli-Integration gefunden${this._config.entity ? ` (${esc(this._config.entity)})` : ""}.<br>
        Nach einem Neustart kann es einige Minuten dauern, bis die Historie geladen ist.</div></ha-card>`;
      return;
    }
    if (!years.length) {
      this.shadowRoot.innerHTML = `${STYLE}<ha-card>${head()}<div class="empty">Noch keine Ladevorgänge vorhanden.</div></ha-card>`;
      return;
    }

    if (this._selected == null || !years.some((y) => y.year === this._selected)) {
      this._selected = years[0].year;
    }
    const sel = years.find((y) => y.year === this._selected);
    const prev = years.find((y) => y.year === sel.year - 1) || null;
    const firstYear = years[years.length - 1].year;
    const now = new Date();
    const isCurrent = sel.year === now.getFullYear();
    const elapsed = isCurrent ? now.getMonth() + 1 : 12;

    // Average per month: only over months the wallbox actually existed.
    let startIdx = 0;
    if (sel.year === firstYear) {
      startIdx = Math.max(0, sel.months.findIndex((m) => m.kwh > 0));
    }
    const activeMonths = Math.max(1, elapsed - startIdx);
    const avg = sel.kwh / activeMonths;

    // Year-over-year for the same period (Jan..current month).
    let yoy = null;
    if (prev) {
      const sum = (y) => y.months.slice(0, elapsed).reduce((s, m) => s + m.kwh, 0);
      const p = sum(prev);
      if (p > 0) yoy = ((sum(sel) - p) / p) * 100;
    }
    const total = Number(st.state) || years.reduce((s, y) => s + y.kwh, 0);

    const chips = years
      .slice()
      .sort((a, b) => a.year - b.year)
      .map((y) => `<span class="chip ${y.year === sel.year ? "on" : ""}" data-year="${y.year}">${y.year}</span>`)
      .join("");

    const yoyHtml =
      yoy == null
        ? `<div class="d">&nbsp;</div>`
        : `<div class="d"><span class="${yoy > 0 ? "up" : "down"}">${yoy > 0 ? "▲" : "▼"} ${fmt(Math.abs(yoy), 1)} %</span>
           vs. ${prev.year}${isCurrent ? ` (bis ${MONTHS[elapsed - 1]})` : ""}</div>`;

    const costYear = this._cost(sel.kwh);
    const proj = this._projection(sel, firstYear);
    const projCost = proj != null ? this._cost(proj) : null;
    const hasSolar = this._showSolar() && sel.solar_kwh != null;
    const stats = `
      <div class="stats">
        <div class="stat"><div class="l">${sel.year}${isCurrent ? " bisher" : ""}</div>
          <div class="v">${fmt(sel.kwh, 1)}<small>kWh</small></div>${yoyHtml}</div>
        <div class="stat"><div class="l">Ø pro Monat</div>
          <div class="v">${fmt(avg, 1)}<small>kWh</small></div><div class="d">über ${activeMonths} Monat${activeMonths === 1 ? "" : "e"}</div></div>
        <div class="stat"><div class="l">Ladevorgänge</div>
          <div class="v">${sel.charges}</div><div class="d">Ø ${fmt(sel.charges ? sel.kwh / sel.charges : 0, 1)} kWh / Ladung</div></div>
        ${costYear ? `<div class="stat"><div class="l">Kosten ${sel.year}</div><div class="v">${costYear}</div>
          <div class="d">@ ${fmt(this._config.price_per_kwh, 2)} ${esc(this._config.currency)}/kWh</div></div>` : ""}
        ${proj != null ? `<div class="stat"><div class="l">Hochrechnung ${sel.year}</div>
          <div class="v proj">~${fmt(proj, 0)}<small>kWh</small></div>
          <div class="d">${projCost ? `≈ ${projCost} · ` : ""}bei gleichem Tempo</div></div>` : ""}
        ${hasSolar ? `<div class="stat"><div class="l">Sonnenanteil ${sel.year}</div>
          <div class="v sun">≤ ${fmt(pct(sel.solar_kwh, sel.kwh), 0)}<small>%</small></div>
          <div class="d">bis zu ${fmt(sel.solar_kwh, 0)} kWh aus PV (Schätzung)</div></div>` : ""}
        <div class="stat"><div class="l">Gesamt seit ${firstYear}</div>
          <div class="v">${fmt(total, 0)}<small>kWh</small></div><div class="d">${st.attributes.charges ?? ""} Ladungen</div></div>
      </div>`;

    const compare = this._config.compare !== false && prev;
    const section = `
      <div class="section"><span>Energie pro Monat · ${sel.year}</span>
        <span class="legend"><span>${sel.year}</span>${hasSolar ? `<span class="sol">davon Sonne (≤)</span>` : ""}${compare ? `<span class="prev">${prev.year}</span>` : ""}</span></div>`;

    this.shadowRoot.innerHTML = `${STYLE}<ha-card>
      ${head(chips)}
      ${this._liveHtml(st)}
      ${stats}
      ${section}
      <div class="chart">${this._chart(sel, compare ? prev : null, isCurrent ? elapsed : 12, hasSolar)}<div class="tip"></div></div>
      ${this._recentHtml(st)}
      <div class="section"><span>Jahre &amp; Monate</span></div>
      <div class="tbl">${this._table(years, now)}</div>
      <div class="foot">Elli Charger · v${CARD_VERSION}</div>
    </ha-card>`;
  }

  _chart(sel, prev, elapsed, hasSolar = false) {
    const W = 640, H = 240, pL = 42, pR = 8, pT = 18, pB = 24;
    const cw = W - pL - pR, ch = H - pT - pB;
    const vals = sel.months.map((m) => m.kwh);
    const pv = prev ? prev.months.map((m) => m.kwh) : [];
    const max = niceMax(Math.max(...vals, ...pv, 1));
    const y = (v) => pT + ch - (v / max) * ch;
    const slot = cw / 12;

    let s = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <defs><linearGradient id="gGreen" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#73bf69"/><stop offset="1" stop-color="#73bf69" stop-opacity=".35"/></linearGradient>
      <linearGradient id="gBlue" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#5794f2" stop-opacity=".55"/><stop offset="1" stop-color="#5794f2" stop-opacity=".15"/></linearGradient></defs>`;

    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i, yy = y(v);
      s += `<line class="gl" x1="${pL}" x2="${W - pR}" y1="${yy}" y2="${yy}"/>
        <text x="${pL - 6}" y="${yy + 3}" text-anchor="end">${fmt(v, v < 10 && max < 20 ? 1 : 0)}</text>`;
    }
    s += `<text x="4" y="${pT - 6}">kWh</text>`;

    const bw = prev ? slot * 0.34 : slot * 0.58;
    for (let i = 0; i < 12; i++) {
      const x0 = pL + i * slot;
      const future = i >= elapsed;
      if (prev && pv[i] > 0) {
        const xp = x0 + slot * 0.13;
        s += `<rect x="${xp}" y="${y(pv[i])}" width="${bw}" height="${pT + ch - y(pv[i])}" rx="2" fill="url(#gBlue)" stroke="#5794f2" stroke-opacity=".6"/>`;
      }
      if (!future && vals[i] > 0) {
        const xc = prev ? x0 + slot * 0.13 + bw + slot * 0.06 : x0 + slot * 0.21;
        s += `<rect x="${xc}" y="${y(vals[i])}" width="${bw}" height="${pT + ch - y(vals[i])}" rx="2" fill="url(#gGreen)" stroke="#73bf69"/>`;
        const sol = hasSolar ? Math.min(sel.months[i].solar_kwh || 0, vals[i]) : 0;
        if (sol > 0) {
          s += `<rect x="${xc}" y="${y(sol)}" width="${bw}" height="${pT + ch - y(sol)}" rx="2" fill="#fade2a" fill-opacity=".8"/>`;
        }
        s += `<text class="val" x="${xc + bw / 2}" y="${y(vals[i]) - 4}" text-anchor="middle">${fmt(vals[i], vals[i] >= 100 ? 0 : 1)}</text>`;
      }
      s += `<text x="${x0 + slot / 2}" y="${H - 7}" text-anchor="middle" ${future ? 'opacity=".4"' : ""}>${MONTHS[i]}</text>
        <rect class="hit" data-i="${i}" x="${x0}" y="${pT}" width="${slot}" height="${ch}"/>`;
    }
    s += `<line x1="${pL}" x2="${W - pR}" y1="${pT + ch}" y2="${pT + ch}" stroke="var(--g-border)"/></svg>`;
    return s;
  }

  _cardsHtml(cards, sep = " · ") {
    const entries = Object.entries(cards || {});
    if (!entries.length) return "";
    return entries.map(([k, v]) => `${esc(this._cardName(k))}: ${fmt(v, 1)} kWh`).join(sep);
  }

  _table(years, now) {
    const hasCost = Number(this._config.price_per_kwh) > 0;
    const hasSolar = this._showSolar() && years.some((y) => y.solar_kwh != null);
    const solCell = (o) =>
      hasSolar ? `<td class="n sun hide-s">${o.solar_kwh != null && o.kwh > 0 ? `≤ ${fmt(pct(o.solar_kwh, o.kwh), 0)} %` : "–"}</td>` : "";
    const maxYear = Math.max(...years.map((y) => y.kwh), 1);
    let h = `<table><thead><tr><th>Jahr / Monat</th><th class="hide-s">Verlauf</th><th>Anteil</th>
      <th class="n">kWh</th><th class="n hide-s">Ladungen</th>${hasCost ? `<th class="n">Kosten</th>` : ""}${hasSolar ? `<th class="n hide-s">Sonne</th>` : ""}</tr></thead><tbody>`;

    const firstYear = years[years.length - 1].year;
    for (const yr of years) {
      const open = this._expanded.has(yr.year);
      const mMax = Math.max(...yr.months.map((m) => m.kwh), 1);
      const spark = `<svg class="spark" width="84" height="18" viewBox="0 0 84 18">${yr.months
        .map((m, i) => {
          const hgt = m.kwh > 0 ? Math.max(1.5, (m.kwh / mMax) * 16) : 0;
          return `<rect x="${i * 7}" y="${18 - hgt}" width="5" height="${hgt}" rx="1"/>`;
        })
        .join("")}</svg>`;
      h += `<tr class="year ${yr.year === this._selected ? "sel" : ""}" data-toggle="${yr.year}">
        <td class="y"><span class="caret ${open ? "open" : ""}">▸</span> ${yr.year}</td>
        <td class="hide-s">${spark}</td>
        <td><div class="gauge"><div style="width:${(yr.kwh / maxYear) * 100}%"></div></div></td>
        <td class="n">${fmt(yr.kwh, 1)}</td><td class="n hide-s">${yr.charges}</td>
        ${hasCost ? `<td class="n">${this._cost(yr.kwh)}</td>` : ""}${solCell(yr)}</tr>`;

      if (open) {
        const isCur = yr.year === now.getFullYear();
        const last = isCur ? now.getMonth() : 11;
        let first = 0;
        if (yr.year === firstYear) first = Math.max(0, yr.months.findIndex((m) => m.kwh > 0));
        for (let i = last; i >= first; i--) {
          const m = yr.months[i];
          const cards = this._cardsHtml(m.cards);
          h += `<tr class="month">
            <td class="m">${MONTHS_LONG[i]}${isCur && i === last ? " <span class='cards'>(lfd.)</span>" : ""}</td>
            <td class="hide-s cards">${cards}</td>
            <td><div class="gauge"><div style="width:${(m.kwh / mMax) * 100}%"></div></div></td>
            <td class="n">${fmt(m.kwh, 1)}</td><td class="n hide-s">${m.charges}</td>
            ${hasCost ? `<td class="n">${this._cost(m.kwh)}</td>` : ""}${solCell(m)}</tr>`;
        }
      }
    }
    return h + "</tbody></table>";
  }

  // ---------------------------------------------------------------- events
  _bindEvents() {
    const root = this.shadowRoot;
    root.addEventListener("click", (ev) => {
      const chip = ev.target.closest("[data-year]");
      if (chip) {
        this._selected = Number(chip.dataset.year);
        this._render();
        return;
      }
      const row = ev.target.closest("[data-toggle]");
      if (row) {
        const y = Number(row.dataset.toggle);
        if (this._expanded.has(y)) this._expanded.delete(y);
        else this._expanded.add(y);
        this._selected = y;
        this._render();
      }
    });

    root.addEventListener("mousemove", (ev) => {
      const hit = ev.target.closest && ev.target.closest(".hit");
      const tip = root.querySelector(".tip");
      if (!tip) return;
      if (!hit) {
        tip.style.display = "none";
        return;
      }
      const years = this._years() || [];
      const sel = years.find((y) => y.year === this._selected);
      if (!sel) return;
      const prev = years.find((y) => y.year === sel.year - 1);
      const i = Number(hit.dataset.i);
      const m = sel.months[i];
      const cost = this._cost(m.kwh);
      let html = `<b>${MONTHS_LONG[i]} ${sel.year}</b>
        <div class="r"><span>Energie</span><span>${fmt(m.kwh, 2)} kWh</span></div>
        <div class="r"><span>Ladungen</span><span>${m.charges}</span></div>`;
      if (cost) html += `<div class="r"><span>Kosten</span><span>${cost}</span></div>`;
      if (this._showSolar() && m.solar_kwh != null && m.kwh > 0) {
        html += `<div class="r"><span>davon Sonne ≤</span><span class="sun">${fmt(m.solar_kwh, 1)} kWh (${fmt(pct(m.solar_kwh, m.kwh), 0)} %)</span></div>`;
      }
      if (prev) {
        const pk = prev.months[i].kwh;
        html += `<div class="r"><span>${prev.year}</span><span>${fmt(pk, 2)} kWh</span></div>`;
      }
      const cards = Object.entries(m.cards || {});
      if (cards.length) {
        html += `<hr>` + cards
          .map(([k, v]) => `<div class="r"><span>${esc(this._cardName(k))}</span><span>${fmt(v, 2)} kWh</span></div>`)
          .join("");
      }
      tip.innerHTML = html;
      tip.style.display = "block";
      const wrap = root.querySelector(".chart").getBoundingClientRect();
      let left = ev.clientX - wrap.left + 14;
      if (left + tip.offsetWidth > wrap.width) left = ev.clientX - wrap.left - tip.offsetWidth - 14;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${Math.max(0, ev.clientY - wrap.top - 20)}px`;
    });

    root.addEventListener("mouseleave", () => {
      const tip = root.querySelector(".tip");
      if (tip) tip.style.display = "none";
    }, true);
  }
}

if (!customElements.get("elli-history-card")) {
  customElements.define("elli-history-card", ElliHistoryCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "elli-history-card",
    name: "Elli Ladehistorie",
    description: "Grafana-ähnliche Jahres-/Monatsübersicht der Elli-Wallbox",
    preview: false,
  });
  console.info(`%c ELLI-HISTORY-CARD %c v${CARD_VERSION} `, "background:#73bf69;color:#000", "background:#181b1f;color:#ccc");
}
