/**
 * animations.mjs
 *
 * Converts a `walker.planTour()` event stream into a complete SMIL-rigged
 * Spider-Man chibi `<g>` element ready to splice into the city SVG.
 *
 * Sub-animations emitted:
 *
 *   1. POSITION   — `<animateTransform type="translate">` on `.ws-root`.
 *                   Per-jump: 4 sub-keyframes approximating a parabolic arc.
 *                   Per-idle: 1 keyframe holding position.
 *
 *   2. FACING     — `<animateTransform type="scale">` on `.ws-flip` with
 *                   `calcMode="discrete"`. Snaps "1 1" ↔ "-1 1" at facing changes.
 *
 *   3. HEAD WOBBLE— `<animateTransform type="rotate">` on `.ws-head`.
 *                   4-step look-around cycle during each idle dwell.
 *
 *   4. WEB STRAND — animated `d` + opacity on a `<path class="ws-web">`.
 *                   Strand goes from chibi's hand to a virtual anchor BEHIND
 *                   the jump direction, ~vertically lifted by arcHeight + 40px.
 *                   That's the canonical Spidey-swing read: release from a
 *                   high anchor on the previous rooftop, swing forward.
 */

import { HAND, buildBody } from "./character.mjs";

const MIN_LOOP_SEC = 6;

/**
 * Build the full chibi `<g>` markup with all SMIL animations.
 *
 * @param {{
 *   tour: { events: any[], totalDuration: number },
 *   loopSec?: number,
 * }} opts
 * @returns {string}
 */
export function buildChibiMarkup({ tour, loopSec }) {
  if (!tour || !tour.events || tour.events.length === 0) {
    return `<g class="ws-root" transform="translate(-1000 -1000)" opacity="0"></g>`;
  }
  const startEvt = tour.events.find((e) => e.type === "start");
  if (!startEvt) {
    return `<g class="ws-root" transform="translate(-1000 -1000)" opacity="0"></g>`;
  }

  const totalDur = Math.max(loopSec ?? tour.totalDuration, MIN_LOOP_SEC);

  // ----- timeline buffers --------------------------------------------------
  const buffers = {
    pos:    { keyTimes: [], values: [] }, // "x,y"
    flip:   { keyTimes: [], values: [] }, // "1 1" / "-1 1"
    head:   { keyTimes: [], values: [] }, // degrees
    webD:   { keyTimes: [], values: [] }, // "M x,y L x,y"
    webOp:  { keyTimes: [], values: [] }, // "0".."1"
  };
  let curX = 0, curY = 0;
  let curFacing = "right";

  function push(buf, t, value, dedup = true) {
    const k = clampUnit(t / totalDur);
    if (dedup && buf.keyTimes.length > 0 && Math.abs(buf.keyTimes.at(-1) - k) < 1e-6) {
      buf.values[buf.values.length - 1] = value;
    } else {
      buf.keyTimes.push(k);
      buf.values.push(value);
    }
  }
  function pushPos(t, x, y) { push(buffers.pos, t, `${fmt(x)},${fmt(y)}`); curX = x; curY = y; }
  function pushFacing(t, facing) {
    if (facing === curFacing && buffers.flip.values.length > 0) return;
    push(buffers.flip, t, facing === "left" ? "-1 1" : "1 1", false);
    curFacing = facing;
  }
  function pushHead(t, deg) { push(buffers.head, t, deg.toString()); }
  function pushWebPath(t, hx, hy, ax, ay) {
    push(buffers.webD, t, `M${fmt(hx)},${fmt(hy)} L${fmt(ax)},${fmt(ay)}`);
  }
  function pushWebOpacity(t, op) { push(buffers.webOp, t, op.toString()); }

  // ----- seed ----------------------------------------------------------
  pushPos(0, startEvt.at.roof.x, startEvt.at.roof.y);
  pushFacing(0, "right");
  pushHead(0, 0);
  pushWebPath(0, HAND.x, HAND.y, HAND.x, HAND.y - 60);
  pushWebOpacity(0, 0);

  // ----- timeline walk -------------------------------------------------
  let t = 0;
  for (const e of tour.events) {
    if (e.type === "start") continue;

    if (e.type === "jump") {
      pushFacing(t + Math.min(0.05, e.dur * 0.1), e.facing);

      const fx = e.from.roof.x, fy = e.from.roof.y;
      const tx = e.to.roof.x,   ty = e.to.roof.y;
      const dx = tx - fx, dy = ty - fy;
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist, uy = dy / dist;

      // Virtual web anchor BEHIND the jump direction.
      // Rationale: Spider-Man releases the strand from above-and-behind
      // the current rooftop, gravity carries the body forward through the
      // arc apex. So the visual line goes from the hand back-and-up.
      const behindLen = Math.max(18, dist * 0.3);
      const verticalLift = e.arcHeight + 35;
      const ax = fx - ux * behindLen;
      const ay = fy - uy * behindLen - verticalLift;

      // 4 arc sub-keyframes.
      for (const frac of [0.25, 0.5, 0.75, 1.0]) {
        const subT = t + e.dur * frac;
        const tau = frac;
        const lerpX = fx + dx * frac;
        const baseY = fy + dy * frac;
        const yOffsetUp = e.arcHeight * 4 * tau * (1 - tau);
        const lerpY = baseY - yOffsetUp;
        pushPos(subT, lerpX, lerpY);

        // Strand path in CHIBI-LOCAL coords (inside .ws-flip frame).
        // Facing-left flips x via scale(-1, 1), so a world-x offset of
        // +Δ becomes a local-x offset of -Δ. We pre-compensate.
        const sign = e.facing === "left" ? -1 : 1;
        const localAx = sign * (ax - lerpX);
        const localAy = ay - lerpY;
        pushWebPath(subT, HAND.x, HAND.y, localAx, localAy);
      }

      // Strand opacity envelope.
      pushWebOpacity(t + e.dur * 0.05, 0);
      pushWebOpacity(t + e.dur * 0.10, 0.9);
      pushWebOpacity(t + e.dur * 0.55, 1.0);
      pushWebOpacity(t + e.dur * 0.85, 0.5);
      pushWebOpacity(t + e.dur * 0.93, 0);

      pushHead(t + e.dur * 0.5, 0);
      pushHead(t + e.dur, 0);

      t += e.dur;
      continue;
    }

    if (e.type === "idle") {
      const heldX = e.at.roof.x;
      const heldY = e.at.roof.y;
      const wobble = [-12, 9, -7, 0];
      for (let i = 0; i < wobble.length; i++) {
        const subT = t + e.dur * ((i + 1) / wobble.length);
        pushHead(subT, wobble[i]);
        pushPos(subT, heldX, heldY);
      }
      t += e.dur;
      continue;
    }
  }

  // ----- pad tail + close loop ----------------------------------------
  if (t < totalDur) {
    pushPos(totalDur, curX, curY);
    pushHead(totalDur, 0);
    pushWebOpacity(totalDur, 0);
  }
  if (buffers.pos.values.at(-1) !== buffers.pos.values[0]) {
    pushPos(totalDur, startEvt.at.roof.x, startEvt.at.roof.y);
  }

  // Normalize: last keyTime → exactly 1.
  for (const b of Object.values(buffers)) {
    if (b.keyTimes.length > 0) b.keyTimes[b.keyTimes.length - 1] = 1;
  }
  const ser = (b) => ({
    keyTimes: b.keyTimes.map((k) => k.toFixed(5)).join(";"),
    values: b.values.join(";"),
  });
  const pos   = ser(buffers.pos);
  const flip  = ser(buffers.flip);
  const head  = ser(buffers.head);
  const webD  = ser(buffers.webD);
  const webOp = ser(buffers.webOp);

  // ----- assemble markup ------------------------------------------------
  const dur = totalDur.toFixed(2);
  const headAnim = `
          <animateTransform attributeName="transform" type="rotate"
                            values="${head.values}"
                            keyTimes="${head.keyTimes}"
                            dur="${dur}s"
                            repeatCount="indefinite"/>`;
  const body = buildBody(headAnim);

  return `<g class="ws-root">
    <animateTransform attributeName="transform" type="translate"
                      values="${pos.values}"
                      keyTimes="${pos.keyTimes}"
                      dur="${dur}s"
                      repeatCount="indefinite"/>
    <g class="ws-flip">
      <animateTransform attributeName="transform" type="scale"
                        values="${flip.values}"
                        keyTimes="${flip.keyTimes}"
                        dur="${dur}s"
                        repeatCount="indefinite"
                        calcMode="discrete"/>
      <path class="ws-web"
            d="M${fmt(HAND.x)},${fmt(HAND.y)} L${fmt(HAND.x)},${fmt(HAND.y - 60)}"
            fill="none"
            stroke="var(--ws-web)" stroke-width="0.5"
            stroke-linecap="round"
            opacity="0">
        <animate attributeName="d"
                 values="${webD.values}"
                 keyTimes="${webD.keyTimes}"
                 dur="${dur}s"
                 repeatCount="indefinite"/>
        <animate attributeName="opacity"
                 values="${webOp.values}"
                 keyTimes="${webOp.keyTimes}"
                 dur="${dur}s"
                 repeatCount="indefinite"/>
      </path>
${indent(body, "      ")}
    </g>
  </g>`;
}

// ===== Helpers ==========================================================

function fmt(n) { return Number.isFinite(n) ? Number(n.toFixed(2)).toString() : "0"; }
function clampUnit(x) { return Math.max(0, Math.min(1, x)); }
function indent(s, pre) { return s.split("\n").map((l) => l ? pre + l : l).join("\n"); }
