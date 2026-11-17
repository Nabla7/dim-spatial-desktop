export const DEPTH_GRID_COLUMNS = 256;

// dimos_lcm_depth maps quality to stride = round(1 / (1/8 + 7/8 * quality)).
// Keep at least the mesh's existing number of columns; finer samples aren't drawn.
export function meshDepthQuality(sourceWidth) {
  const stride = Math.max(1, Math.min(8, Math.floor(sourceWidth / DEPTH_GRID_COLUMNS)));
  return (1 / stride - 1 / 8) / (7 / 8);
}
