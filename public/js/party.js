// Party client — a thin, reconnecting wrapper over the room WebSocket.

export class Party extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.you = null;
    this.code = null;
    this.room = null;
    this._queue = [];
  }

  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/party`);
    this.ws.onopen = () => {
      for (const m of this._queue.splice(0)) this.ws.send(JSON.stringify(m));
      this.emit('open');
    };
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'joined') { this.you = msg.you; this.code = msg.code; }
      if (msg.type === 'room') this.room = msg.room;
      this.emit(msg.type, msg);
    };
    this.ws.onclose = () => { this.emit('closed'); };
  }

  emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  on(type, fn) { this.addEventListener(type, (e) => fn(e.detail)); return this; }

  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
    else { this._queue.push(msg); this.connect(); }
  }

  get isHost() { return this.room && this.room.hostId === this.you; }
  get me() { return this.room?.players.find((p) => p.id === this.you) || null; }

  create(identity, videoId, videoTitle) { this.send({ type: 'create', ...identity, videoId, videoTitle }); }
  join(code, identity) { this.send({ type: 'join', code: String(code).toUpperCase(), ...identity }); }
  setVideo(videoId, videoTitle) { this.send({ type: 'setVideo', videoId, videoTitle }); }
  ready(v) { this.send({ type: 'ready', ready: v }); }
  start() { this.send({ type: 'start' }); }
  tick(score, combo) { this.send({ type: 'score', score, combo }); }
  finish(score, accuracy) { this.send({ type: 'finish', score, accuracy }); }
  again() { this.send({ type: 'again' }); }
  react(emoji) { this.send({ type: 'react', emoji }); }
  leave() { this.send({ type: 'leave' }); this.room = null; this.code = null; }
}
