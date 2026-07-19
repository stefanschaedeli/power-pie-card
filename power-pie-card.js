/**
 * power-pie-card
 * A dependency-free doughnut chart card for Home Assistant with built-in
 * entity filtering, a sorted value legend, and freeze-on-hover updates.
 *
 * https://github.com/stefanschaedeli/power-pie-card
 * MIT License
 */

const VERSION = "0.2.0";

// Validated categorical palette (8 slots, light + dark surface variants).
// Hue order is CVD-safety-optimized — do not reorder or cycle past 8;
// extra slices fold into "other".
const PALETTE_LIGHT = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"];
const PALETTE_DARK  = ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767", "#d55181", "#d95926"];
const OTHER_COLOR     = { light: "#898781", dark: "#6f6e67" }; // folded small slices
const REMAINDER_COLOR = { light: "#c3c2b7", dark: "#4a4a46" }; // unmeasured rest

const TOUCH_HOLD_MS = 10000; // freeze duration after last touch interaction

// --- helpers ---------------------------------------------------------------

function globToRegExp(pattern) {
  if (pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
    return new RegExp(pattern.slice(1, -1));
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function parseStateMatcher(spec) {
  const cmp = String(spec).match(/^\s*(<=|>=|<|>|=)\s*(-?[\d.]+)\s*$/);
  if (cmp) {
    const op = cmp[1];
    const ref = Number(cmp[2]);
    return (state) => {
      const v = Number(state);
      if (!isFinite(v)) return false;
      switch (op) {
        case "<": return v < ref;
        case ">": return v > ref;
        case "<=": return v <= ref;
        case ">=": return v >= ref;
        case "=": return v === ref;
      }
      return false;
    };
  }
  const literal = String(spec).toLowerCase();
  return (state) => String(state).toLowerCase() === literal;
}

function compileRule(rule) {
  const tests = [];
  if (rule.entity_id) {
    const re = globToRegExp(String(rule.entity_id));
    tests.push((id) => re.test(id));
  }
  if (rule.domain) {
    tests.push((id) => id.split(".")[0] === rule.domain);
  }
  if (rule.state !== undefined) {
    const match = parseStateMatcher(rule.state);
    tests.push((id, hass) => {
      const st = hass.states[id];
      return st !== undefined && match(st.state);
    });
  }
  if (rule.area) {
    const want = String(rule.area).toLowerCase();
    tests.push((id, hass) => {
      const reg = hass.entities && hass.entities[id];
      let areaId = reg && reg.area_id;
      if (!areaId && reg && reg.device_id && hass.devices) {
        const dev = hass.devices[reg.device_id];
        areaId = dev && dev.area_id;
      }
      if (!areaId) return false;
      if (areaId.toLowerCase() === want) return true;
      const area = hass.areas && hass.areas[areaId];
      return !!area && String(area.name).toLowerCase() === want;
    });
  }
  return (id, hass) => tests.every((t) => t(id, hass));
}

// Convert a state object's numeric value to watts using its unit.
function toWatts(value, unit) {
  const u = (unit || "").toLowerCase();
  if (u === "kw") return value * 1000;
  if (u === "mw") return value / 1000; // milliwatts
  return value; // W or unknown → assume W
}

// --- card ------------------------------------------------------------------

class PowerPieCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._slots = new Map();       // entity_id → palette slot (stable colors)
    this._arcs = new Map();        // slice id → SVG circle element
    this._frozen = false;
    this._pendingModel = null;
    this._modelKey = null;
    this._touchTimer = null;
  }

  static getStubConfig() {
    return {
      title: "Power",
      filter: { include: [{ entity_id: "sensor.*_pwr*" }], exclude: [{ state: "< 1" }] },
      display_unit: "W",
    };
  }

  static getConfigElement() {
    return document.createElement("power-pie-card-editor");
  }

  setConfig(config) {
    if (!config.filter && !config.entities) {
      throw new Error("power-pie-card: define `filter` and/or `entities`");
    }
    const c = { ...config };
    c.unknown_text = c.unknown_text || c.unknownText || "Unknown";
    c.display_unit = c.display_unit === "kW" ? "kW" : "W";
    c.decimals = Number.isFinite(c.decimals) ? c.decimals : (c.display_unit === "kW" ? 2 : 0);
    c.sort = c.sort === "none" ? "none" : "max";
    c.max_slices = Math.min(Number.isFinite(c.max_slices) ? c.max_slices : 8, PALETTE_LIGHT.length);
    c.other_text = c.other_text || "Other";
    this._include = (c.filter && c.filter.include ? c.filter.include : []).map(compileRule);
    this._exclude = (c.filter && c.filter.exclude ? c.filter.exclude : []).map(compileRule);
    this._static = (c.entities || []).map((e) =>
      typeof e === "string" ? { entity: e } : e
    );
    this._config = c;
    this._modelKey = null;
    this._buildDom();
    if (this._hass) this.hass = this._hass;
  }

  _buildDom() {
    const root = this.shadowRoot;
    root.innerHTML = "";

    const style = document.createElement("style");
    style.textContent = `
      :host { height: 100%; }
      ha-card { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
      .body {
        flex: 1; display: flex; flex-direction: column;
        gap: 8px; padding: 0 16px 12px; container-type: size;
        /* min-height doubles as the fallback height in masonry views, where
           the card gets no definite height and size containment would
           otherwise collapse the body to 0. */
        min-height: 160px;
      }
      ha-card.headless .body { padding-top: 12px; }
      .layout {
        flex: 1; min-height: 0; display: flex; flex-direction: column;
        align-items: center; gap: 4px 16px;
      }
      .chart {
        position: relative; flex: 0 1 auto; min-height: 0; min-width: 0;
        height: 55cqh; aspect-ratio: 1; max-width: 100%;
      }
      .legend {
        flex: 1 1 auto; min-height: 0; overflow-y: auto; width: 100%;
        display: flex; flex-direction: column; align-self: stretch;
        scrollbar-width: thin;
      }
      /* Wide card: doughnut left, legend right */
      @container (min-aspect-ratio: 6/4) {
        .layout { flex-direction: row; justify-content: center; }
        .chart { height: 92cqh; }
        .legend { flex: 0 1 auto; width: auto; max-width: 60cqw; justify-content: center; }
      }
      svg { width: 100%; height: 100%; display: block; }
      .arc {
        fill: none;
        stroke-width: 7;
        transition: stroke-dasharray .6s ease, stroke-dashoffset .6s ease,
                    stroke-width .15s ease, opacity .3s ease;
        cursor: pointer;
      }
      .arc.dim { opacity: 0.35; }
      .arc.hot { stroke-width: 8.6; }
      .center {
        position: absolute; inset: 0; display: flex; flex-direction: column;
        align-items: center; justify-content: center; pointer-events: none;
        text-align: center; line-height: 1.15;
      }
      .center .value {
        font-size: clamp(14px, 9cqh, 28px); font-weight: 600;
        color: var(--primary-text-color, #0b0b0b);
      }
      .center .unit {
        font-size: clamp(10px, 5cqh, 14px);
        color: var(--secondary-text-color, #52514e);
      }
      .row {
        display: grid; grid-template-columns: 12px 1fr auto auto;
        gap: 0 8px; align-items: center; padding: 2px 4px; border-radius: 6px;
        font-size: 13px; cursor: pointer; user-select: none;
      }
      .row.inert { cursor: default; }
      .row:hover, .row.hot { background: var(--secondary-background-color, rgba(127,127,127,.12)); }
      .row .dot { width: 10px; height: 10px; border-radius: 50%; }
      .row .name {
        color: var(--primary-text-color, #0b0b0b); overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap;
      }
      .row .val, .row .pct {
        color: var(--secondary-text-color, #52514e);
        font-variant-numeric: tabular-nums; text-align: right;
      }
      .row .pct { min-width: 3.5em; }
      .tooltip {
        position: absolute; pointer-events: none; z-index: 2;
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #0b0b0b);
        border: 1px solid var(--divider-color, rgba(127,127,127,.3));
        border-radius: 6px; padding: 4px 8px; font-size: 12px;
        box-shadow: 0 2px 8px rgba(0,0,0,.15);
        white-space: nowrap; display: none;
      }
      .paused {
        position: absolute; top: 2px; right: 2px; font-size: 11px;
        color: var(--secondary-text-color, #52514e); opacity: .7; display: none;
      }
      .empty {
        flex: 1; display: flex; align-items: center; justify-content: center;
        color: var(--secondary-text-color, #52514e); font-size: 13px;
      }
    `;

    this._card = document.createElement("ha-card");
    if (this._config.title) this._card.header = this._config.title;
    else this._card.classList.add("headless");

    this._body = document.createElement("div");
    this._body.className = "body";

    this._layoutEl = document.createElement("div");
    this._layoutEl.className = "layout";

    this._chartEl = document.createElement("div");
    this._chartEl.className = "chart";

    this._svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this._svg.setAttribute("viewBox", "0 0 42 42");

    this._centerEl = document.createElement("div");
    this._centerEl.className = "center";
    this._centerEl.innerHTML = `<div class="value"></div><div class="unit"></div>`;

    this._tooltipEl = document.createElement("div");
    this._tooltipEl.className = "tooltip";

    this._pausedEl = document.createElement("div");
    this._pausedEl.className = "paused";
    this._pausedEl.textContent = "⏸";
    this._pausedEl.title = "Updates paused while inspecting";

    this._legendEl = document.createElement("div");
    this._legendEl.className = "legend";

    this._emptyEl = document.createElement("div");
    this._emptyEl.className = "empty";
    this._emptyEl.style.display = "none";

    this._chartEl.append(this._svg, this._centerEl, this._tooltipEl);
    this._layoutEl.append(this._chartEl, this._legendEl);
    this._body.append(this._layoutEl, this._emptyEl, this._pausedEl);
    this._card.append(this._body);
    this.shadowRoot.append(style, this._card);
    this._arcs.clear();

    // Freeze while the pointer is over the card body (mouse) or for a hold
    // period after touch interaction.
    this._body.addEventListener("pointerenter", (ev) => {
      if (ev.pointerType === "mouse") this._setFrozen(true);
    });
    this._body.addEventListener("pointerleave", (ev) => {
      if (ev.pointerType === "mouse") this._setFrozen(false);
    });
    this._body.addEventListener("touchstart", () => {
      this._setFrozen(true);
      clearTimeout(this._touchTimer);
      this._touchTimer = setTimeout(() => this._setFrozen(false), TOUCH_HOLD_MS);
    }, { passive: true });
  }

  _setFrozen(frozen) {
    this._frozen = frozen;
    if (!frozen && this._pendingModel) {
      const m = this._pendingModel;
      this._pendingModel = null;
      this._render(m);
    }
    this._updatePausedBadge();
  }

  _updatePausedBadge() {
    this._pausedEl.style.display = this._frozen && this._pendingModel ? "block" : "none";
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    const model = this._computeModel(hass);
    if (model.key === this._modelKey) return;
    if (this._frozen) {
      this._pendingModel = model;
      this._updatePausedBadge();
      return;
    }
    this._render(model);
  }

  get hass() {
    return this._hass;
  }

  _computeModel(hass) {
    const c = this._config;
    const dark = !!(hass.themes && hass.themes.darkMode);
    const palette = dark ? PALETTE_DARK : PALETTE_LIGHT;

    // Collect candidate entity ids: static list + include-filter matches.
    const meta = new Map(); // id → {name?, color?}
    for (const e of this._static) meta.set(e.entity, e);
    const ids = new Set(this._static.map((e) => e.entity));
    if (this._include.length) {
      for (const id of Object.keys(hass.states)) {
        if (this._include.some((rule) => rule(id, hass))) ids.add(id);
      }
    }

    // Excludes + numeric parse (unavailable/unknown/non-numeric drop out here).
    let items = [];
    for (const id of ids) {
      if (this._exclude.some((rule) => rule(id, hass))) continue;
      const st = hass.states[id];
      if (!st) continue;
      const raw = Number(st.state);
      if (!isFinite(raw)) continue;
      const watts = toWatts(raw, st.attributes.unit_of_measurement);
      if (watts <= 0) continue;
      const m = meta.get(id) || {};
      items.push({
        id,
        name: m.name || st.attributes.friendly_name || id,
        color: m.color,
        watts,
      });
    }

    if (c.sort === "max") items.sort((a, b) => b.watts - a.watts);

    // Fold slices beyond the palette into "other" (never cycle hues).
    let folded = null;
    if (items.length > c.max_slices) {
      const rest = items.slice(c.max_slices);
      items = items.slice(0, c.max_slices);
      folded = {
        id: "__other__",
        name: `${c.other_text} (${rest.length})`,
        watts: rest.reduce((s, x) => s + x.watts, 0),
        color: dark ? OTHER_COLOR.dark : OTHER_COLOR.light,
        inert: true,
      };
    }

    // Stable color slots: an entity keeps its hue for the card's lifetime.
    const used = new Set(this._slots.values());
    for (const it of items) {
      if (it.color) continue;
      if (!this._slots.has(it.id)) {
        let slot = 0;
        while (used.has(slot)) slot++;
        this._slots.set(it.id, slot % palette.length);
        used.add(slot % palette.length);
      }
      it.color = palette[this._slots.get(it.id)];
    }
    // Release slots of entities that left the set (lets colors recycle cleanly).
    const present = new Set(items.map((i) => i.id));
    for (const key of [...this._slots.keys()]) {
      if (!present.has(key)) this._slots.delete(key);
    }

    const measured = items.reduce((s, x) => s + x.watts, 0) + (folded ? folded.watts : 0);

    // Total: entity, number, or fall back to the measured sum.
    let total = measured;
    let remainder = null;
    if (c.total_amount !== undefined) {
      const st = hass.states[c.total_amount];
      let t = NaN;
      if (st) t = toWatts(Number(st.state), st.attributes.unit_of_measurement);
      else if (isFinite(Number(c.total_amount))) t = Number(c.total_amount);
      if (isFinite(t) && t > 0) {
        total = Math.max(t, measured);
        const rest = t - measured;
        if (rest > 0) {
          remainder = {
            id: "__remainder__",
            name: c.unknown_text,
            watts: rest,
            color: dark ? REMAINDER_COLOR.dark : REMAINDER_COLOR.light,
            inert: true,
          };
        }
      }
    }

    const slices = [...items];
    if (folded) slices.push(folded);
    if (remainder) slices.push(remainder);

    const fmt = (watts) => {
      const v = c.display_unit === "kW" ? watts / 1000 : watts;
      return `${v.toLocaleString(undefined, {
        minimumFractionDigits: c.decimals,
        maximumFractionDigits: c.decimals,
      })}`;
    };

    for (const s of slices) {
      s.valueText = fmt(s.watts);
      s.pct = total > 0 ? (s.watts / total) * 100 : 0;
      s.pctText = s.pct >= 0.95 ? `${Math.round(s.pct)}%` : "<1%";
    }

    const model = {
      slices,
      totalText: fmt(total),
      unit: c.display_unit,
      dark,
    };
    // Diff key: only what is actually displayed. Sub-resolution jitter in the
    // source sensors therefore causes no re-render at all.
    model.key = JSON.stringify([
      dark,
      model.totalText,
      slices.map((s) => [s.id, s.name, s.valueText, s.pctText, s.color]),
    ]);
    return model;
  }

  _render(model) {
    this._modelKey = model.key;
    this._pendingModel = null;
    this._updatePausedBadge();

    const empty = model.slices.length === 0;
    this._layoutEl.style.display = empty ? "none" : "";
    this._emptyEl.style.display = empty ? "" : "none";
    if (empty) {
      this._emptyEl.textContent = "No matching entities";
      return;
    }

    // --- doughnut arcs (stroke-dasharray technique, C = 100) ---
    const R = 15.91549431;
    const GAP = model.slices.length > 1 ? 0.8 : 0;
    let start = 0;
    const seen = new Set();
    for (const s of model.slices) {
      seen.add(s.id);
      let el = this._arcs.get(s.id);
      const isNew = !el;
      if (isNew) {
        el = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        el.setAttribute("class", "arc");
        el.setAttribute("cx", "21");
        el.setAttribute("cy", "21");
        el.setAttribute("r", String(R));
        el.setAttribute("stroke-dasharray", "0 100");
        el.setAttribute("stroke-dashoffset", "125");
        this._attachArcEvents(el, s.id);
        this._svg.appendChild(el);
        this._arcs.set(s.id, el);
      }
      const len = Math.max(s.pct - GAP, 0.15);
      const dashStart = start + GAP / 2;
      const apply = () => {
        el.style.stroke = s.color;
        el.setAttribute("stroke-dasharray", `${len} ${100 - len}`);
        el.setAttribute("stroke-dashoffset", String(125 - dashStart));
      };
      if (isNew) requestAnimationFrame(apply);
      else apply();
      start += s.pct;
    }
    // Remove arcs whose slice left the set (shrink out, then detach).
    for (const [id, el] of [...this._arcs.entries()].filter(([id]) => !seen.has(id))) {
      this._arcs.delete(id);
      el.setAttribute("stroke-dasharray", "0 100");
      setTimeout(() => el.remove(), 650);
    }

    // --- center label ---
    this._centerEl.querySelector(".value").textContent = model.totalText;
    this._centerEl.querySelector(".unit").textContent = model.unit;

    // --- legend (safe to rebuild: renders never happen while hovered) ---
    this._legendEl.innerHTML = "";
    for (const s of model.slices) {
      const row = document.createElement("div");
      row.className = "row" + (s.inert ? " inert" : "");
      row.dataset.id = s.id;
      row.innerHTML = `
        <span class="dot"></span>
        <span class="name"></span>
        <span class="val"></span>
        <span class="pct"></span>`;
      row.querySelector(".dot").style.background = s.color;
      row.querySelector(".name").textContent = s.name;
      row.querySelector(".val").textContent = `${s.valueText} ${model.unit}`;
      row.querySelector(".pct").textContent = s.pctText;
      row.addEventListener("mouseenter", () => this._highlight(s.id, true));
      row.addEventListener("mouseleave", () => this._highlight(s.id, false));
      if (!s.inert) {
        row.addEventListener("click", () => this._moreInfo(s.id));
      }
      this._legendEl.appendChild(row);
    }
    this._model = model;
  }

  _attachArcEvents(el, id) {
    el.dataset.id = id;
    el.addEventListener("mouseenter", () => this._highlight(id, true));
    el.addEventListener("mouseleave", () => {
      this._highlight(id, false);
      this._tooltipEl.style.display = "none";
    });
    el.addEventListener("mousemove", (ev) => this._showTooltip(id, ev));
    el.addEventListener("click", () => {
      if (!id.startsWith("__")) this._moreInfo(id);
    });
  }

  _highlight(id, on) {
    for (const [aid, el] of this._arcs) {
      el.classList.toggle("hot", on && aid === id);
      el.classList.toggle("dim", on && aid !== id);
    }
    for (const row of this._legendEl.children) {
      row.classList.toggle("hot", on && row.dataset.id === id);
    }
  }

  _showTooltip(id, ev) {
    const s = this._model && this._model.slices.find((x) => x.id === id);
    if (!s) return;
    const tt = this._tooltipEl;
    tt.textContent = `${s.name}: ${s.valueText} ${this._model.unit} (${s.pctText})`;
    tt.style.display = "block";
    const rect = this._chartEl.getBoundingClientRect();
    let x = ev.clientX - rect.left + 12;
    let y = ev.clientY - rect.top - 10;
    tt.style.left = `${Math.min(x, rect.width - tt.offsetWidth - 4)}px`;
    tt.style.top = `${Math.max(y, 0)}px`;
  }

  _moreInfo(entityId) {
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      detail: { entityId },
      bubbles: true,
      composed: true,
    }));
  }

  getCardSize() {
    return 4;
  }

  getGridOptions() {
    return { columns: 12, rows: 4, min_columns: 6, min_rows: 3 };
  }
}

customElements.define("power-pie-card", PowerPieCard);

// --- GUI editor ------------------------------------------------------------
//
// Uses HA's native ha-form + selectors. The common filter case (one include
// glob + one "hide below N W" exclude) gets first-class GUI fields; anything
// more complex falls back to an object (YAML) sub-editor for just the filter,
// while every other option stays GUI-editable.

const MANAGED_KEYS = ["title", "total_amount", "display_unit", "decimals",
  "unknown_text", "other_text", "max_slices", "sort"];

const EDITOR_LABELS = {
  title: "Title",
  total_amount: "Total sensor (derives the unmeasured slice)",
  display_unit: "Display unit",
  decimals: "Decimals",
  unknown_text: "Label for unmeasured remainder",
  other_text: "Label for folded small slices",
  max_slices: "Max colored slices",
  sort: "Sort order",
  filter_pattern: "Include entities matching (glob, e.g. *_pwr*)",
  filter_min: "Hide entities below (W)",
  filter: "Filter (advanced — too complex for the simple fields)",
};

class PowerPieCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._initialized = false;
  }

  setConfig(config) {
    this._config = { ...config };
    this._analyzeFilter();
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  // Simple-filter detection: at most one include rule using only
  // entity_id (+ optional domain, kept as passthrough), and at most one
  // exclude rule of the form {state: "< N"}.
  _analyzeFilter() {
    const f = this._config.filter;
    this._simpleFilter = true;
    this._includeExtra = {};
    this._pattern = "";
    this._min = undefined;
    if (!f) return;
    const inc = f.include || [];
    const exc = f.exclude || [];
    if (inc.length > 1 || exc.length > 1) { this._simpleFilter = false; return; }
    if (inc.length === 1) {
      const rule = { ...inc[0] };
      delete rule.options;
      const { entity_id, domain, ...rest } = rule;
      if (Object.keys(rest).length || !entity_id) { this._simpleFilter = false; return; }
      this._pattern = entity_id;
      if (domain) this._includeExtra.domain = domain;
    }
    if (exc.length === 1) {
      const rule = { ...exc[0] };
      delete rule.options;
      const keys = Object.keys(rule);
      const m = keys.length === 1 && keys[0] === "state" &&
        String(rule.state).match(/^\s*<\s*(-?[\d.]+)\s*$/);
      if (!m) { this._simpleFilter = false; return; }
      this._min = Number(m[1]);
    }
  }

  async _ensureHaForm() {
    if (customElements.get("ha-form")) return;
    // Force HA to register ha-form + selectors by loading a built-in
    // card editor once (standard custom-card technique).
    const helpers = await window.loadCardHelpers?.();
    if (helpers) {
      const card = await helpers.createCardElement({ type: "entities", entities: [] });
      await card.constructor.getConfigElement?.();
    }
    await customElements.whenDefined("ha-form");
  }

  async _render() {
    if (!this._initialized) {
      this._initialized = true;
      const style = document.createElement("style");
      style.textContent = ":host { display: block; } ha-form { display: block; }";
      this._mount = document.createElement("div");
      this.shadowRoot.append(style, this._mount);
      await this._ensureHaForm();
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
      this._form.addEventListener("value-changed", (ev) => this._valueChanged(ev));
      this._mount.append(this._form);
    }
    if (!this._form) return;

    const c = this._config;
    const schema = [
      { name: "title", selector: { text: {} } },
      { name: "total_amount", selector: { entity: { domain: "sensor" } } },
      {
        name: "display_unit",
        selector: { select: { mode: "dropdown", options: [
          { value: "W", label: "W" }, { value: "kW", label: "kW" },
        ] } },
      },
      { name: "decimals", selector: { number: { min: 0, max: 3, step: 1, mode: "box" } } },
    ];
    if (this._simpleFilter) {
      schema.push(
        { name: "filter_pattern", selector: { text: {} } },
        { name: "filter_min", selector: { number: { min: 0, step: 1, mode: "box", unit_of_measurement: "W" } } },
      );
    } else {
      schema.push({ name: "filter", selector: { object: {} } });
    }
    schema.push(
      { name: "unknown_text", selector: { text: {} } },
      { name: "other_text", selector: { text: {} } },
      { name: "max_slices", selector: { number: { min: 1, max: 8, step: 1, mode: "box" } } },
      {
        name: "sort",
        selector: { select: { mode: "dropdown", options: [
          { value: "max", label: "Largest first" }, { value: "none", label: "Config order" },
        ] } },
      },
    );

    const data = {};
    for (const k of MANAGED_KEYS) if (c[k] !== undefined) data[k] = c[k];
    if (data.unknown_text === undefined && c.unknownText !== undefined) {
      data.unknown_text = c.unknownText;
    }
    if (this._simpleFilter) {
      if (this._pattern) data.filter_pattern = this._pattern;
      if (this._min !== undefined) data.filter_min = this._min;
    } else if (c.filter !== undefined) {
      data.filter = c.filter;
    }

    this._form.schema = schema;
    this._form.data = data;
    if (this._hass) this._form.hass = this._hass;
  }

  _valueChanged(ev) {
    ev.stopPropagation();
    const d = ev.detail.value || {};
    const cfg = { ...this._config };
    delete cfg.unknownText; // normalize legacy alias on save
    for (const k of MANAGED_KEYS) {
      if (d[k] === undefined || d[k] === "") delete cfg[k];
      else cfg[k] = d[k];
    }
    if (this._simpleFilter) {
      const include = [];
      if (d.filter_pattern) include.push({ ...this._includeExtra, entity_id: d.filter_pattern });
      const exclude = [];
      if (typeof d.filter_min === "number" && d.filter_min > 0) {
        exclude.push({ state: `< ${d.filter_min}` });
      }
      if (include.length || exclude.length) cfg.filter = { include, exclude };
      else delete cfg.filter;
    } else if (d.filter !== undefined) {
      cfg.filter = d.filter;
    }
    this._config = cfg;
    this._analyzeFilter();
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: cfg },
      bubbles: true,
      composed: true,
    }));
  }
}

customElements.define("power-pie-card-editor", PowerPieCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "power-pie-card",
  name: "Power Pie Card",
  description:
    "Doughnut chart with built-in entity filtering, sorted value legend, and freeze-on-hover updates.",
  documentationURL: "https://github.com/stefanschaedeli/power-pie-card",
});

console.info(
  `%c POWER-PIE-CARD %c v${VERSION} `,
  "color: #fff; background: #2a78d6; font-weight: 600;",
  "color: #2a78d6; background: #fff; font-weight: 600;"
);
