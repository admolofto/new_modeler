/**
 * Viewport colors. The panels use the same meanings (ui/theme.ts): amber = selected,
 * violet = what an AI proposal changes, red = notes, yellow = an opening door or drawer hitting something.
 * Hover stays blue so it never reads as selected.
 * The gizmo keeps the usual red / green / blue for x / y / z, and turns yellow under the cursor.
 */
export const PALETTE = {
  canvas: 0x1d1f23,
  selected: 0xff9f2e,
  selectedCss: '#ff9f2e',
  hover: 0x4da3ff,
  hoverCss: '#4da3ff',
  /** Emissive tint on parts an AI proposal adds or changes. */
  ai: 0x6f5cff,
  /** Emissive tint on what an opening door or drawer hits (warn yellow, as --warn in the panels). */
  clash: 0xe5c07b,
  note: 0xe8543f,
  noteCss: '#e8543f',
  /** Dimension lines: neutral, like pencil on a drawing. */
  dimension: 0xc3c8d0,
  /** Blockout placeholders: clay gray, so they never read as wood; the front face lighter, the arrow on top darker. */
  blockCss: '#a9aeb7',
  blockFrontCss: '#d3d7dd',
  blockMark: 0x5d626b,
  axisX: 0xe5534b,
  axisY: 0x6cc24a,
  axisZ: 0x3d7df2,
  gizmoHot: 0xffd84d,
  /** Floor grid (render/grid.ts): 1' lines, the bolder 4' lines, the axes through the origin. */
  gridMinor: 0x303338,
  gridMajor: 0x44474e,
  gridAxis: 0x55585f,
} as const;
