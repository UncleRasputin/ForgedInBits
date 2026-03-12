/**
 * arcade.js — BROCADE.GAMES Score Client
 * ────────────────────────────────────────────────────────────────────────────
 * Include in any game with a single script tag:
 *   <script src="js/arcade.js"></script>
 *
 * QUICK START:
 *   const arcade = new Arcade({ gameId: 'your-game-id' });
 *   await arcade.ready();
 *
 *   // Submit a score on game over — never throws, never blocks your game:
 *   const result = await arcade.submitScore({ score: 9420, wave: 12 });
 *   // result.ok        → saved successfully
 *   // result.offline   → server unreachable, game keeps running normally
 *
 *   // Show the leaderboard:
 *   const board = await arcade.getLeaderboard();
 *   // board.leaderboard → ranked array of personal bests
 *
 * TODO: replace local path with CDN url when available:
 *   <script src="https://brocade.games/arcade.js"></script>
 */

const ARCADE_STORAGE_KEY = 'arcade.local.player';
const DEFAULT_SERVER     = 'https://arcade-scores.brocade.workers.dev';

class Arcade {
  /**
   * @param {object}  options
   * @param {string}  options.gameId          — must match a registered game
   * @param {string}  [options.server]        — override the worker URL
   * @param {number}  [options.timeout=4000]  — ms before requests give up
   * @param {boolean} [options.debug=false]   — log to console
   * @param {string}  [options.apiKey]        — required for write/admin calls
   */
  constructor(options = {}) {
    if (!options.gameId) throw new Error('[Arcade] gameId is required');
    this.gameId  = options.gameId;
    this.server  = (options.server || DEFAULT_SERVER).replace(/\/$/, '');
    this.timeout = options.timeout ?? 4000;
    this.debug   = options.debug ?? false;
    this.apiKey  = options.apiKey ?? null;
    this._player = null;
    this._schema = null;
    this._ready  = false;
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  /**
   * Load or create the local player profile, then fetch the game schema.
   * Call once before any other method.
   * @returns {Promise<{ player, schema }>}
   */
  async ready() {
    this._player = this._loadOrCreatePlayer();
    try {
      this._schema = await this._fetch(`/games/${this.gameId}`);
      this._log('Schema loaded', this._schema);
    } catch {
      this._log('Schema unavailable (offline?) — validation disabled');
    }
    this._ready = true;
    return { player: { ...this._player }, schema: this._schema };
  }

  // ── Player ─────────────────────────────────────────────────────────────────

  /** Current player profile (read-only copy). */
  get player() {
    return this._player ? { ...this._player } : null;
  }

  /**
   * Update the player's display name (persisted in localStorage).
   * @param {string} name
   */
  setPlayerName(name) {
    if (!name || typeof name !== 'string') throw new Error('[Arcade] name must be a non-empty string');
    this._player.name = name.trim().slice(0, 32);
    this._savePlayer();
    return { ...this._player };
  }

  /**
   * Generate a fresh player ID (previous scores become unlinked).
   */
  resetPlayer() {
    localStorage.removeItem(ARCADE_STORAGE_KEY);
    this._player = this._loadOrCreatePlayer();
    return { ...this._player };
  }

  // ── Scores ─────────────────────────────────────────────────────────────────

  /**
   * Submit a score. Always resolves — never throws.
   * If the server is unreachable, returns { ok: false, offline: true }.
   *
   * @param {object} meta  — fields matching the game's scoreSchema
   *                         e.g. { score: 9420, wave: 12, time: 84.5 }
   * @returns {Promise<{ ok, entry?, offline?, error? }>}
   */
  async submitScore(meta) {
    this._assertReady();
    if (!meta || typeof meta !== 'object') return { ok: false, error: 'meta must be an object' };
    try {
      const result = await this._fetch('/scores', {
        method: 'POST',
        body: {
          gameId:     this.gameId,
          playerId:   this._player.id,
          playerName: this._player.name,
          meta,
        },
      });
      this._log('Score submitted', result);
      return { ok: true, entry: result.entry };
    } catch (err) {
      this._log('submitScore offline', err.message);
      return { ok: false, offline: true, error: err.message };
    }
  }

  /**
   * Fetch the leaderboard (personal best per player, ranked).
   * Returns null on failure.
   * @returns {Promise<LeaderboardResponse|null>}
   */
  async getLeaderboard() {
    this._assertReady();
    try {
      const data = await this._fetch(`/scores/${this.gameId}`);
      this._log('Leaderboard', data);
      return data;
    } catch (err) {
      this._log('getLeaderboard failed', err.message);
      return null;
    }
  }

  /**
   * Current player's full session history for this game.
   * Returns null on failure.
   */
  async getMyHistory() {
    this._assertReady();
    try {
      return await this._fetch(`/scores/${this.gameId}/player/${this._player.id}`);
    } catch (err) {
      this._log('getMyHistory failed', err.message);
      return null;
    }
  }

  /**
   * Full session history for the game (all players, paginated).
   * @param {{ limit?: number, cursor?: string }} [opts]
   */
  async getHistory(opts = {}) {
    this._assertReady();
    const params = new URLSearchParams();
    if (opts.limit)  params.set('limit', String(opts.limit));
    if (opts.cursor) params.set('cursor', opts.cursor);
    const qs = params.toString() ? `?${params}` : '';
    try {
      return await this._fetch(`/scores/${this.gameId}/history${qs}`);
    } catch (err) {
      this._log('getHistory failed', err.message);
      return null;
    }
  }

  // ── Game registration ──────────────────────────────────────────────────────

  /**
   * Register (or update) this game's schema.
   * Requires apiKey to be set.
   * @param {object} schema — see game.json template for the full spec
   */
  async registerGame(schema) {
    try {
      const result = await this._fetch('/games', { method: 'POST', body: schema });
      this._log('Game registered', result);
      return result;
    } catch (err) {
      this._log('registerGame failed', err.message);
      return { ok: false, error: err.message };
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _loadOrCreatePlayer() {
    try {
      const raw = localStorage.getItem(ARCADE_STORAGE_KEY);
      if (raw) { const p = JSON.parse(raw); if (p.id && p.name) return p; }
    } catch { /**/ }
    const player = {
      id:        this._generateId(),
      name:      'PLAYER_' + Math.floor(Math.random() * 9000 + 1000),
      createdAt: new Date().toISOString(),
    };
    this._savePlayer(player);
    return player;
  }

  _savePlayer(player = this._player) {
    try { localStorage.setItem(ARCADE_STORAGE_KEY, JSON.stringify(player)); } catch { /**/ }
  }

  _generateId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
  }

  async _fetch(path, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const fetchOpts = {
      method:  opts.method || 'GET',
      signal:  controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'X-Arcade-Key': this.apiKey } : {}),
      },
    };
    if (opts.body) fetchOpts.body = JSON.stringify(opts.body);
    try {
      const res  = await fetch(`${this.server}${path}`, fetchOpts);
      clearTimeout(timer);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error('Request timed out');
      throw err;
    }
  }

  _assertReady() {
    if (!this._ready) throw new Error('[Arcade] Call await arcade.ready() before using this method');
  }

  _log(...args) {
    if (this.debug) console.log('[Arcade]', ...args);
  }
}

// ── Export ────────────────────────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  window.Arcade = Arcade;
}
