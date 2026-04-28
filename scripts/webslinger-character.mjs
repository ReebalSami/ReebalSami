/**
 * webslinger-character.mjs
 *
 * Builds a tiny chibi web-slinger character drawn DIRECTLY in outer SVG
 * pixel coordinates (no internal scale). Small enough to stand on a single
 * iso-calendar cube roof (~14x7 px). The character is drawn centered at
 * (0, 0) horizontally, with feet at y=0 and head at y≈-14. The inject
 * layer animates this character's position + facing direction.
 *
 * Exports:
 *   buildCharacterBody({ theme }): string       — static SVG markup
 *   PALETTE                       : object      — theme-keyed colors
 */

export const PALETTE = {
  light: {
    redPrimary: "#B82626",
    blueDark:   "#1E2D5C",
    eyeWhite:   "#FAF9F4",
    eyeBorder:  "#22222A",
    web:        "rgba(34,34,42,0.7)",
    accent:     "#B6803F",
  },
  dark: {
    redPrimary: "#C32A2A",
    blueDark:   "#3A4F8C",
    eyeWhite:   "#F5F4EE",
    eyeBorder:  "#0d1117",
    web:        "rgba(245,244,238,0.7)",
    accent:     "#D4A574",
  },
};

/**
 * Build the character body, centered at (0,0) horizontally, feet at y=0.
 *
 * Bounding box: roughly x in [-5, 5], y in [-14, 0].
 * Designed to fit on a single iso-calendar cube top.
 */
export function buildCharacterBody({ theme = "light" }) {
  const c = PALETTE[theme];

  return `
    <!-- web strand: thin line from anchor above to the right hand.
         Inject layer toggles its opacity in sync with jump events. -->
    <line class="ws-web"
          x1="2.5" y1="-160"
          x2="2.5" y2="-13"
          stroke="${c.web}" stroke-width="0.7"
          stroke-linecap="round"
          opacity="0"/>

    <!-- back leg -->
    <rect class="ws-leg-back"
          x="-2.2" y="-4" width="1.6" height="4.4" rx="0.6"
          fill="${c.blueDark}"/>

    <!-- front leg -->
    <rect class="ws-leg-front"
          x="0.6" y="-4" width="1.6" height="4.4" rx="0.6"
          fill="${c.blueDark}"/>

    <!-- torso (red) -->
    <rect class="ws-torso"
          x="-2.6" y="-9" width="5.2" height="5.5" rx="1"
          fill="${c.redPrimary}"/>
    <!-- chest accent: tiny golden belt line -->
    <rect x="-2.6" y="-4.4" width="5.2" height="0.5" fill="${c.accent}" opacity="0.85"/>

    <!-- back arm (drawn before head so it sits behind) -->
    <rect class="ws-arm-back"
          x="-3.7" y="-8.5" width="1.3" height="3.6" rx="0.5"
          fill="${c.redPrimary}"/>

    <!-- front arm: extended up-right, holds the web. Two segments
         (upper + forearm) with the hand near (3, -13). -->
    <g class="ws-arm-front">
      <rect x="2.4" y="-9.2" width="1.4" height="2.8" rx="0.5"
            fill="${c.redPrimary}"/>
      <rect x="2.0" y="-12.5" width="1.4" height="3.5" rx="0.5"
            fill="${c.redPrimary}"
            transform="rotate(-15 2.7 -10.7)"/>
      <!-- glove (hand) at the tip -->
      <circle cx="2.5" cy="-13" r="0.9" fill="${c.blueDark}"/>
    </g>

    <!-- head: red mask with white angled eye-lenses.
         Drawn so that it can be rotated around (0, -11) for "look around" idle. -->
    <g class="ws-head">
      <!-- mask base (slightly oversized for chibi look) -->
      <ellipse cx="0" cy="-11" rx="3.4" ry="3" fill="${c.redPrimary}"/>
      <!-- left eye lens -->
      <ellipse cx="-1.4" cy="-11" rx="1.1" ry="0.7"
               fill="${c.eyeWhite}"
               stroke="${c.eyeBorder}" stroke-width="0.18"
               transform="rotate(-15 -1.4 -11)"/>
      <!-- right eye lens -->
      <ellipse cx="1.4" cy="-11" rx="1.1" ry="0.7"
               fill="${c.eyeWhite}"
               stroke="${c.eyeBorder}" stroke-width="0.18"
               transform="rotate(15 1.4 -11)"/>
    </g>
  `.trim();
}
