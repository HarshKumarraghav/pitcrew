// Replays trace.json (written by scripts/demo/record.mjs) into the unmodified dashboard.
// The dashboard opens `new EventSource("/governor/events")`; this replaces EventSource with one
// that plays the recorded `state` and `log` frames on a loop, shifting timestamps to "now".
(() => {
  const listeners = {};
  const loaded = fetch("trace.json").then((r) => r.json());

  function shift(data, by) {
    if (typeof data.t === "number") data.t += by;
    for (const e of data.events || []) e.t += by;
    return data;
  }

  function emit(type, data) {
    for (const fn of listeners[type] || []) {
      try {
        fn({ data: JSON.stringify(data) });
      } catch (e) {
        console.error(e); // one bad frame must not stop the loop
      }
    }
    const conn = document.getElementById("conn");
    if (conn) {
      conn.textContent = "▶ replay";
      conn.className = "info";
    }
  }

  async function play() {
    const trace = await loaded;
    const banner = document.getElementById("replay-note");
    if (banner) banner.querySelector("b").textContent = `${trace.backend} backend · ${trace.machine} · recorded ${trace.recordedAt.slice(0, 10)}`;
    for (let loop = 0; ; loop++) {
      const start = performance.now();
      const by = Date.now() - trace.t0;
      if (loop) emit("log", { t: Date.now(), type: "info", msg: "─── replay restarts ───" });
      for (const f of trace.frames) {
        const wait = f.at - (performance.now() - start);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        emit(f.event, shift(structuredClone(f.data), by));
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
  }

  window.EventSource = class {
    constructor() {
      play();
    }
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    }
    close() {}
  };
})();
