/**
 * webslinger-character.mjs
 *
 * Generates an animated chibi-proportioned web-slinger SVG <g> group with
 * SMIL-rigged limbs (separate body, head, arms, legs, web strand) suitable
 * for injection into another SVG. Stylized homage — simplified mask, custom
 * proportions, partial web pattern — distinct enough to read as fan-art.
 *
 * Exports:
 *   buildWebslinger({ theme, width, swingPath, durationSec })
 *     theme:       "light" | "dark"
 *     width:       outer SVG width in user units (used to size the path if not given)
 *     swingPath:   SVG path "d" string in outer SVG coords (the arc the character travels)
 *     durationSec: total loop duration in seconds (default 14)
 *   returns: { group: string }   // the <g class="webslinger"> markup
 *
 *   buildSwingPath({ width, height, anchorY, anchors, peak })
 *     Computes a smooth multi-arc swing path through `anchors` ([{x,y}]) using
 *     cubic Béziers, with `peak` being how high the apex of each arc rises.
 */

const PALETTE = {
  light: {
    redPrimary: "#B82626",   // Spidey red, slightly muted for editorial feel
    redShadow:  "#8A1A1A",
    bluePrimary: "#1E2D5C",
    blueShadow:  "#131F45",
    skin:        "#F5DCC0",   // not visible — full mask
    eyeWhite:    "#FAF9F4",
    eyeBorder:   "#22222A",
    web:         "rgba(34,34,42,0.55)",
    accent:      "#B6803F",   // golden — used for tiny detail
  },
  dark: {
    redPrimary: "#A02020",
    redShadow:  "#6F1414",
    bluePrimary: "#2A3D78",
    blueShadow:  "#1B2A55",
    skin:        "#F5DCC0",
    eyeWhite:    "#F5F4EE",
    eyeBorder:   "#22222A",
    web:         "rgba(245,244,238,0.55)",
    accent:      "#D4A574",
  },
};

/**
 * Build a multi-anchor swing path. Goes through each anchor with a high arc
 * between them. Each segment is a cubic Bézier with two control points pulled
 * up by `peak`. Returns "M x0 y0 C cx1 cy1, cx2 cy2, x1 y1 C ... Z" minus the
 * close — the character loops back to start via animateMotion's keyTimes.
 */
export function buildSwingPath({ anchors, peak = 60 }) {
  if (anchors.length < 2) {
    throw new Error("Need at least 2 anchors for swing path");
  }
  let d = `M ${anchors[0].x} ${anchors[0].y}`;
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1];
    const b = anchors[i];
    // Two control points: each pulled up by `peak`, horizontally a third in.
    const cx1 = a.x + (b.x - a.x) / 3;
    const cy1 = Math.min(a.y, b.y) - peak;
    const cx2 = a.x + (2 * (b.x - a.x)) / 3;
    const cy2 = Math.min(a.y, b.y) - peak;
    d += ` C ${cx1} ${cy1}, ${cx2} ${cy2}, ${b.x} ${b.y}`;
  }
  return d;
}

/**
 * The chibi character itself, drawn at origin (0,0). The character's
 * "anchor point" is roughly between the shoulders — that's where animateMotion
 * positions the group. So all paths are drawn relative to that anchor.
 *
 * Design notes:
 *   - Head is a flat oval-ish blue mask sitting above the body
 *   - Body is a stocky red torso with three thin web lines (vertical+horizontal+diagonal)
 *   - Two arms stick out, the right one extended upward holding the web strand
 *   - Two legs dangle, with phase-offset swing animations to simulate stride
 *   - Web strand is a vertical line going up from right hand to anchor (off-canvas top)
 *   - Total visual size: ~24px wide × 32px tall
 */
function buildCharacterBody(theme, durationSec = 14) {
  const c = PALETTE[theme];
  const D = durationSec;

  // Limb swing keyframes — simulates a jump-cycle:
  //   0%   = mid-air apex (legs tucked, arms extended)
  //   25%  = descending (legs uncoiling)
  //   50%  = landing (legs down, arms back)
  //   75%  = pushing off (legs coil, arms swing forward)
  //   100% = back to apex
  // Phase offset: animation cycle = 1/4 of total swing (4 sub-jumps per loop).
  const cycleDur = D / 4;

  return `
    <!-- web strand: a line from above going down to the right hand -->
    <line class="ws-web"
          x1="6" y1="-180"
          x2="6" y2="-12"
          stroke="${c.web}" stroke-width="1.4"
          stroke-linecap="round"
          stroke-dasharray="3 2">
      <animate attributeName="opacity"
               values="1; 1; 0.5; 0; 0; 1"
               keyTimes="0; 0.2; 0.35; 0.5; 0.85; 1"
               dur="${cycleDur}s"
               repeatCount="indefinite"/>
      <animate attributeName="y1"
               values="-180; -180; -110; -40; -180; -180"
               keyTimes="0; 0.2; 0.35; 0.5; 0.85; 1"
               dur="${cycleDur}s"
               repeatCount="indefinite"/>
    </line>

    <!-- back leg (drawn first so it's behind torso) -->
    <g class="ws-leg-back">
      <rect x="-3" y="6" width="3.2" height="9" rx="1.4"
            fill="${c.bluePrimary}"/>
      <!-- foot -->
      <ellipse cx="-1.4" cy="15.5" rx="2.2" ry="1.2" fill="${c.blueShadow}"/>
      <animateTransform attributeName="transform"
                        type="rotate"
                        values="-15; 30; 10; -25; -15"
                        keyTimes="0; 0.25; 0.5; 0.75; 1"
                        dur="${cycleDur}s"
                        repeatCount="indefinite"/>
    </g>

    <!-- front leg -->
    <g class="ws-leg-front">
      <rect x="-0.2" y="6" width="3.2" height="9" rx="1.4"
            fill="${c.bluePrimary}"/>
      <ellipse cx="1.4" cy="15.5" rx="2.2" ry="1.2" fill="${c.blueShadow}"/>
      <animateTransform attributeName="transform"
                        type="rotate"
                        values="20; -25; -10; 25; 20"
                        keyTimes="0; 0.25; 0.5; 0.75; 1"
                        dur="${cycleDur}s"
                        repeatCount="indefinite"/>
    </g>

    <!-- torso (red with simplified web pattern) -->
    <g class="ws-torso">
      <!-- main body -->
      <path d="M -5 -2
               Q -5.5 -3 -4 -3
               L 4 -3
               Q 5.5 -3 5 -2
               L 5 6.5
               Q 5 7.5 4 7.5
               L -4 7.5
               Q -5 7.5 -5 6.5 Z"
            fill="${c.redPrimary}"/>
      <!-- shading on left side -->
      <path d="M -5 -2
               Q -5.5 -3 -4 -3
               L -2.5 -3
               L -2.5 7.5
               L -4 7.5
               Q -5 7.5 -5 6.5 Z"
            fill="${c.redShadow}" opacity="0.4"/>
      <!-- vertical web line -->
      <line x1="0" y1="-3" x2="0" y2="7.5"
            stroke="${c.eyeBorder}" stroke-width="0.25" opacity="0.55"/>
      <!-- horizontal web line -->
      <line x1="-5" y1="2" x2="5" y2="2"
            stroke="${c.eyeBorder}" stroke-width="0.25" opacity="0.55"/>
      <!-- spider emblem on chest (abstracted small icon) -->
      <circle cx="0" cy="2" r="1.1" fill="${c.eyeBorder}" opacity="0.85"/>
      <!-- 4 little legs flaring out from the body emblem -->
      <path d="M -1.6 1 L -2.2 0.4 M 1.6 1 L 2.2 0.4 M -1.6 3 L -2.2 3.6 M 1.6 3 L 2.2 3.6"
            stroke="${c.eyeBorder}" stroke-width="0.25" stroke-linecap="round" opacity="0.85" fill="none"/>
      <!-- belt accent in golden brand color -->
      <line x1="-5" y1="6.5" x2="5" y2="6.5"
            stroke="${c.accent}" stroke-width="0.5" opacity="0.85"/>
    </g>

    <!-- back arm (drawn before head/front-arm so it goes behind) -->
    <g class="ws-arm-back" transform="translate(-4, -1)">
      <rect x="-2.5" y="0" width="2.5" height="8" rx="1.2"
            fill="${c.redPrimary}"/>
      <!-- glove -->
      <circle cx="-1.2" cy="8.5" r="1.6" fill="${c.bluePrimary}"/>
      <animateTransform attributeName="transform"
                        type="rotate"
                        values="-20 -4 -1; 30 -4 -1; 50 -4 -1; 10 -4 -1; -20 -4 -1"
                        keyTimes="0; 0.25; 0.5; 0.75; 1"
                        dur="${cycleDur}s"
                        repeatCount="indefinite"
                        additive="sum"/>
    </g>

    <!-- head -->
    <g class="ws-head">
      <!-- mask base (slightly oversized for chibi) -->
      <ellipse cx="0" cy="-7.5" rx="6" ry="6.5" fill="${c.redPrimary}"/>
      <!-- mask side shadow -->
      <path d="M -6 -7.5
               A 6 6.5 0 0 1 0 -14
               L 0 -7.5 Z"
            fill="${c.redShadow}" opacity="0.35"/>
      <!-- web pattern across mask: 3 thin curves -->
      <path d="M -5.5 -8 Q 0 -10.5 5.5 -8"
            fill="none" stroke="${c.eyeBorder}" stroke-width="0.25" opacity="0.5"/>
      <path d="M -5.5 -6 Q 0 -3.5 5.5 -6"
            fill="none" stroke="${c.eyeBorder}" stroke-width="0.25" opacity="0.5"/>
      <line x1="0" y1="-13.5" x2="0" y2="-1.5"
            stroke="${c.eyeBorder}" stroke-width="0.25" opacity="0.5"/>
      <!-- left eye lens (asymmetric, classic Spidey angled lens) -->
      <path d="M -5 -8.5
               Q -4.5 -11 -1.2 -10.3
               Q -0.5 -8.5 -1.8 -7.3
               Q -3.8 -7 -5 -8.5 Z"
            fill="${c.eyeWhite}"
            stroke="${c.eyeBorder}" stroke-width="0.4"/>
      <!-- right eye lens -->
      <path d="M 5 -8.5
               Q 4.5 -11 1.2 -10.3
               Q 0.5 -8.5 1.8 -7.3
               Q 3.8 -7 5 -8.5 Z"
            fill="${c.eyeWhite}"
            stroke="${c.eyeBorder}" stroke-width="0.4"/>
      <!-- subtle head tilt animation -->
      <animateTransform attributeName="transform"
                        type="rotate"
                        values="-3 0 -7.5; 3 0 -7.5; -3 0 -7.5"
                        keyTimes="0; 0.5; 1"
                        dur="${cycleDur * 2}s"
                        repeatCount="indefinite"/>
    </g>

    <!-- front arm (the one holding the web strand — anchored upward) -->
    <g class="ws-arm-front" transform="translate(4, -1)">
      <rect x="0" y="-1" width="2.5" height="9" rx="1.2"
            fill="${c.redPrimary}"/>
      <!-- glove (closed fist gripping web) -->
      <circle cx="1.2" cy="-1.5" r="1.7" fill="${c.bluePrimary}"/>
      <!-- The web strand starts here at (1.2, -3) — visually continues the line -->
      <animateTransform attributeName="transform"
                        type="rotate"
                        values="-160 4 -1; -120 4 -1; -90 4 -1; -140 4 -1; -160 4 -1"
                        keyTimes="0; 0.25; 0.5; 0.75; 1"
                        dur="${cycleDur}s"
                        repeatCount="indefinite"
                        additive="sum"/>
    </g>
  `.trim();
}

/**
 * Build the full webslinger group, complete with animateMotion along the
 * given path. The group is self-contained — drop it anywhere as a child of
 * an SVG and it'll animate.
 */
export function buildWebslinger({
  theme = "light",
  swingPath,
  durationSec = 14,
  scale = 2.6,
}) {
  if (!swingPath) {
    throw new Error("buildWebslinger requires swingPath");
  }
  const body = buildCharacterBody(theme, durationSec);

  // The animateMotion is on an INNER group; an OUTER group applies the
  // scale. We keep rotate at 0 (default) so the character stays upright like
  // someone hanging from a web — auto-rotation made him lie flat at apexes.
  return `
<g class="webslinger">
  <g transform="scale(${scale})" style="transform-origin: 0 0;">
    ${body}
  </g>
  <animateMotion dur="${durationSec}s"
                 repeatCount="indefinite"
                 calcMode="spline"
                 keySplines="0.42 0 0.58 1; 0.42 0 0.58 1; 0.42 0 0.58 1; 0.42 0 0.58 1; 0.42 0 0.58 1"
                 keyTimes="0; 0.25; 0.5; 0.75; 0.95; 1"
                 path="${swingPath}"/>
</g>
`.trim();
}

/**
 * Convenience: pick anchor positions for the swing path given outer SVG
 * dimensions. Anchors are spread across the width at varying heights so the
 * arc sweep feels organic. The hang-line of the character should clear the
 * iso-calendar grid (which sits roughly in the upper third of the metrics SVG).
 */
export function defaultAnchorsForSize({ width, height }) {
  // Place 6 anchors across the width at roughly 60-75% of the height so the
  // character swings just below the iso calendar's top edge.
  const baseY = Math.max(60, height * 0.4);
  const apexY = Math.max(40, height * 0.18);
  const positions = [
    { x: width * 0.05, y: baseY + 30 },
    { x: width * 0.22, y: baseY },
    { x: width * 0.38, y: baseY + 15 },
    { x: width * 0.55, y: baseY - 5 },
    { x: width * 0.72, y: baseY + 20 },
    { x: width * 0.88, y: baseY },
    { x: width * 0.95, y: baseY + 30 },
  ];
  return { anchors: positions, baseY, apexY };
}
