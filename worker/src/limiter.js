// Durable Object: a fixed-window counter. One object per (action, visitor) or (action, day).
// It deletes its own data when the window ends, so nothing about a visitor is kept afterwards.

export class Limiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const { limit, windowSec, cost = 1 } = await request.json();
    const now = Date.now();
    let rec = await this.state.storage.get('w');
    if (!rec || now - rec.start >= windowSec * 1000) rec = { start: now, count: 0 };
    const resetAt = rec.start + windowSec * 1000;
    if (rec.count + cost > limit) {
      return Response.json({ ok: false, retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)) });
    }
    rec.count += cost;
    await this.state.storage.put('w', rec);
    await this.state.storage.setAlarm(resetAt + 1000);
    return Response.json({ ok: true, remaining: limit - rec.count });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}
