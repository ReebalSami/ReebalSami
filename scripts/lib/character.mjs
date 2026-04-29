/**
 * character.mjs
 *
 * The Spider-Man chibi sprite. Drawn at outer iso-pixel scale, centered
 * at (0, 0) horizontally with feet at y = 0 and head at y ≈ -10.
 *
 * Design contract for animation (`animations.mjs`):
 *
 *   <g class="ws-root">                  ← positioned by translate(roof)
 *     <g class="ws-flip">                ← scale(±1, 1) = facing flip
 *       <line class="ws-web" .../>       ← strand: animated x1/y1/x2/y2
 *       <g class="ws-body">              ← all body parts
 *         ...torso, arms, legs, head...
 *         <g class="ws-head">
 *           <animateTransform .../>      ← head wobble (idle look-around)
 *         </g>
 *       </g>
 *     </g>
 *   </g>
 *
 * The web strand is INSIDE the flip group so left/right facing flips its
 * hand-anchor x correctly. Its endpoints are animated per-jump by
 * `animations.mjs` to point from the chibi's hand toward a virtual anchor
 * BEHIND the jump direction (canonical-Spider-Man swing).
 *
 * Theme colors come from CSS variables (`--ws-red` etc.) set by the
 * style block in `svg-render.mjs`.
 */

// Hand anchor in chibi-local coords. Web strand `x1, y1` track this.
export const HAND = { x: 2.6, y: -10.0 };

/**
 * Build the chibi body markup. Pass `headAnimation` to splice an SMIL
 * `<animateTransform>` inside the `.ws-head` group (head wobble during
 * idles). Pass empty string for no head animation.
 *
 * @param {string} [headAnimation=""] inner SMIL markup for the head group
 */
export function buildBody(headAnimation = "") {
  return `
        <!-- back leg -->
        <rect class="ws-leg-back"  x="-1.7" y="-3.2" width="1.3" height="3.4" rx="0.5" fill="var(--ws-blue)"/>
        <!-- front leg -->
        <rect class="ws-leg-front" x="0.4"  y="-3.2" width="1.3" height="3.4" rx="0.5" fill="var(--ws-blue)"/>
        <!-- torso (red) -->
        <rect class="ws-torso"     x="-2.0" y="-7.0" width="4.0" height="4.2" rx="0.9" fill="var(--ws-red)"/>
        <!-- belt accent -->
        <rect x="-2.0" y="-3.2" width="4.0" height="0.4" fill="var(--ws-accent)" opacity="0.85"/>
        <!-- back arm -->
        <rect class="ws-arm-back"  x="-2.9" y="-6.6" width="1.0" height="2.8" rx="0.4" fill="var(--ws-red)"/>
        <!-- front arm: extends up-right toward HAND for the web -->
        <g class="ws-arm-front">
          <rect x="1.9"  y="-7.1" width="1.1" height="2.2" rx="0.4" fill="var(--ws-red)"/>
          <rect x="1.6"  y="-9.6" width="1.1" height="2.7" rx="0.4" fill="var(--ws-red)"
                transform="rotate(-15 2.1 -8.3)"/>
          <!-- glove (hand) at HAND -->
          <circle cx="${HAND.x.toFixed(2)}" cy="${HAND.y.toFixed(2)}" r="0.7" fill="var(--ws-blue)"/>
        </g>
        <!-- head (rotated by animations.mjs during idle via headAnimation) -->
        <g class="ws-head">${headAnimation}
          <ellipse cx="0" cy="-8.6" rx="2.6" ry="2.4" fill="var(--ws-red)"/>
          <ellipse cx="-1.05" cy="-8.6" rx="0.9" ry="0.55" fill="var(--ws-eye)"
                   stroke="var(--ws-stroke)" stroke-width="0.14"
                   transform="rotate(-15 -1.05 -8.6)"/>
          <ellipse cx="1.05"  cy="-8.6" rx="0.9" ry="0.55" fill="var(--ws-eye)"
                   stroke="var(--ws-stroke)" stroke-width="0.14"
                   transform="rotate(15 1.05 -8.6)"/>
        </g>
  `.trim();
}

