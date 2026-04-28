/**
 * parse-iso-calendar.mjs
 *
 * Extracts every contribution cube from a lowlighter/metrics isocalendar
 * SVG and returns its absolute roof position in OUTER pixel coordinates,
 * its level (0–4 GitHub intensity bucket), and its visual height.
 *
 * The lowlighter isocalendar is structured as:
 *
 *   <g transform="scale(4) translate(12, 0)">          ← parent
 *     <g transform="translate(W_X, W_Y)">              ← week column
 *       <g transform="translate(D_X, D_Y)">            ← day cell (LEAF)
 *         <path fill="#XXXXXX" d="M1.7,2 0,1 1.7,0 3.4,1 z"/>     ← top face
 *         <path fill="#XXXXXX" d="M0,1 1.7,2 1.7,Y 0,Y-1 z"/>     ← left side
 *         <path fill="#XXXXXX" d="M1.7,2 3.4,1 3.4,Y 1.7,Y-1 z"/> ← right side
 *       </g>
 *       …more day cells
 *     </g>
 *     …more week columns
 *   </g>
 *
 * Day cells are leaf groups (their direct children are paths only).
 * Each leaf cell yields ONE building record:
 *
 *   {
 *     px:    pixel x of the cube's top-face center (in OUTER SVG coords)
 *     py:    pixel y of the cube's top-face center
 *     level: 0..4 (GitHub intensity bucket; 0 = empty)
 *     fill:  raw hex string from the top path
 *     height: cube height in iso-local units (>= 0)
 *   }
 *
 * Coordinate transform:
 *   The parent has transform="scale(4) translate(12, 0)" which, per SVG
 *   spec (right-to-left composition), means: first translate by (12, 0),
 *   then scale by 4. So a point (x, y) in the calendar's local coord
 *   system maps to outer pixel (4*(x+12), 4*y) = (4x+48, 4y).
 */

// GitHub Primer color → level (works for both light AND dark themes,
// because lowlighter uses the LIGHT palette regardless of theme).
const COLOR_TO_LEVEL = {
  "#ebedf0": 0, // empty
  "#9be9a8": 1, // L1 light
  "#40c463": 2, // L2 light  (note: GitHub doc shows #30c463; lowlighter renders #40c463)
  "#30c463": 2, // alt L2
  "#30a14e": 3, // L3 light
  "#216e39": 4, // L4 light
  // Halloween palette (in case lowlighter falls into it):
  "#ffee4a": 1,
  "#ffc501": 2,
  "#fe9600": 3,
  "#03001c": 4,
  // Winter palette:
  "#0a3069": 1,
  "#0969da": 2,
  "#54aeff": 3,
  "#b6e3ff": 4,
};

const ISO_PARENT_RE =
  /<g\s+transform="scale\(4\)\s+translate\(\s*12\s*,\s*0\s*\)">/;

/**
 * Find the iso-calendar parent group and return its inner content + the
 * indices of where it starts and ends in the original SVG. Returns null if
 * not found.
 */
export function findIsoCalendarBlock(svg) {
  const m = svg.match(ISO_PARENT_RE);
  if (!m) return null;
  const startTagEnd = m.index + m[0].length;

  // Find matching </g> by counting <g> depth.
  let depth = 1;
  let i = startTagEnd;
  while (i < svg.length && depth > 0) {
    // Match <g followed by space, tab, > to avoid matching <gXXX
    if (svg.startsWith("<g", i) && /[\s>]/.test(svg[i + 2])) {
      depth++;
      i += 2;
    } else if (svg.startsWith("</g>", i)) {
      depth--;
      if (depth === 0) {
        return {
          openTagStart: m.index,
          openTagEnd: startTagEnd,
          innerStart: startTagEnd,
          innerEnd: i,
          closeTagEnd: i + 4,
          inner: svg.substring(startTagEnd, i),
        };
      }
      i += 4;
    } else {
      i++;
    }
  }
  return null;
}

/**
 * Parse all building cubes from the iso-calendar block. Token stream:
 *   <g transform="translate(...)">  -> push frame onto stack
 *   <path fill="..." d="..."/>      -> add to current frame's paths
 *   </g>                            -> pop; if frame had paths AND no
 *                                      sub-groups, treat as a cell
 */
export function parseBuildings(svg) {
  const block = findIsoCalendarBlock(svg);
  if (!block) {
    console.warn("⚠️  Iso-calendar block not found in SVG");
    return [];
  }
  const inner = block.inner;

  // Tokenize. We capture three kinds of tokens:
  //   1) <g transform="translate(X, Y)">       (group open)
  //   2) <path fill="#XXX" ... d="..."/>       (cell path)
  //   3) </g>                                  (group close)
  const tokenRe = new RegExp(
    [
      // Group 1+2: translate dx, dy
      String.raw`<g\s+transform="translate\(\s*([-0-9.]+)\s*,\s*([-0-9.]+)\s*\)"\s*>`,
      // Group 3+4: path fill and d (we look for fill BEFORE d; lowlighter writes them in either order so we match each separately)
      String.raw`<path\b[^>]*?\bfill="(#[0-9a-fA-F]{6})"[^>]*?\bd="([^"]+)"[^>]*?\/>`,
      // Match closing </g>
      String.raw`<\/g>`,
    ].join("|"),
    "g"
  );

  const cells = [];
  /** @type {{x:number,y:number,paths:{fill:string,d:string}[],hadChildG:boolean}[]} */
  const stack = [{ x: 0, y: 0, paths: [], hadChildG: false }];

  let m;
  while ((m = tokenRe.exec(inner)) !== null) {
    if (m[1] !== undefined) {
      // <g transform="translate(...)">
      const top = stack[stack.length - 1];
      top.hadChildG = true;
      stack.push({
        x: top.x + parseFloat(m[1]),
        y: top.y + parseFloat(m[2]),
        paths: [],
        hadChildG: false,
      });
    } else if (m[3] !== undefined) {
      // <path fill="..." d="...">
      const top = stack[stack.length - 1];
      top.paths.push({ fill: m[3].toLowerCase(), d: m[4] });
    } else {
      // </g>
      const popped = stack.pop();
      // Treat as a leaf cell only if it has paths and no nested <g>.
      if (popped.paths.length >= 1 && !popped.hadChildG) {
        const fill = popped.paths[0].fill;
        const level = COLOR_TO_LEVEL[fill] ?? 0;

        // Cube height: in the side path d="M0,1 1.7,2 1.7,Y2 0,Y1 z",
        // Y2 is the bottom-back y coord. Empty cubes have Y2 == 2.
        // Height = Y2 - 2 (in iso-local y units).
        let height = 0;
        if (popped.paths.length >= 2) {
          const sideD = popped.paths[1].d;
          // Match: "1.7,2 1.7,Y2 0,Y1 z" -> capture Y2
          const yMatch = sideD.match(
            /1\.7\s*,\s*2\s+1\.7\s*,\s*([0-9.]+)\s+0\s*,\s*[0-9.]+/
          );
          if (yMatch) {
            height = Math.max(0, parseFloat(yMatch[1]) - 2);
          }
        }

        // Cell-local roof center: (1.7, 1) is the rhombus visual center.
        // Apply parent transform: scale(4) translate(12, 0) means
        // (x, y) -> (4*(x+12), 4*y).
        const localX = popped.x + 1.7;
        const localY = popped.y + 1;
        const px = 4 * (localX + 12);
        const py = 4 * localY;

        cells.push({ px, py, level, fill, height });
      }
    }
  }

  return cells;
}

/**
 * Convenience: filtered list of "buildings" — cells with level >= 1.
 */
export function getBuildings(svg) {
  return parseBuildings(svg).filter((c) => c.level >= 1);
}
