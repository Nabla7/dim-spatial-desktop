// Where a point lands in a camera's picture: a pinhole with OpenCV's lens distortion (plumb_bob has
// k1 k2 p1 p2 k3, rational_polynomial adds k4 k5 k6). The point is in the camera's optical frame: x right,
// y down, z forward. The formula is here twice, in GLSL for a shader and in JavaScript for a check of it.

// The eight coefficients the formula takes, from a CameraInfo's model and D. A model this formula does not
// describe (a fisheye) gives null: its picture cannot be placed, and a wrong placement is worse than none.
export function distortion(model, D) {
  const coefficients = new Float32Array(8), given = Array.from(D || []);
  if (!given.some(value => value !== 0)) return coefficients;
  if (!/^(plumb_bob|rational_polynomial)$/.test(String(model || ''))) return null;
  given.slice(0, 8).forEach((value, i) => { coefficients[i] = value; });
  return coefficients;
}

// [u, v] in pixels for a point in front of the camera, else null. intrinsics: [fx, fy, cx, cy].
export function project([x, y, z], [fx, fy, cx, cy], d) {
  if (!(z > 0)) return null;
  const nx = x / z, ny = y / z, r2 = nx * nx + ny * ny, r4 = r2 * r2, r6 = r4 * r2;
  const radial = (1 + d[0] * r2 + d[1] * r4 + d[4] * r6) / (1 + d[5] * r2 + d[6] * r4 + d[7] * r6);
  const dx = nx * radial + 2 * d[2] * nx * ny + d[3] * (r2 + 2 * nx * nx);
  const dy = ny * radial + d[2] * (r2 + 2 * ny * ny) + 2 * d[3] * nx * ny;
  return [fx * dx + cx, fy * dy + cy];
}

// colorPixel(p): the same, for a fragment shader. The caller checks p.z > 0 first.
export const projectGlsl = /* glsl */`
uniform vec4 colorIntrinsics;      // fx, fy, cx, cy in the colour camera's pixels
uniform float colorDistortion[8];  // k1 k2 p1 p2 k3 k4 k5 k6
vec2 colorPixel(vec3 p) {
  vec2 n = p.xy / p.z;
  float r2 = dot(n, n), r4 = r2 * r2, r6 = r4 * r2;
  float radial = (1.0 + colorDistortion[0] * r2 + colorDistortion[1] * r4 + colorDistortion[4] * r6)
    / (1.0 + colorDistortion[5] * r2 + colorDistortion[6] * r4 + colorDistortion[7] * r6);
  vec2 d = n * radial + vec2(
    2.0 * colorDistortion[2] * n.x * n.y + colorDistortion[3] * (r2 + 2.0 * n.x * n.x),
    colorDistortion[2] * (r2 + 2.0 * n.y * n.y) + 2.0 * colorDistortion[3] * n.x * n.y);
  return vec2(colorIntrinsics.x * d.x + colorIntrinsics.z, colorIntrinsics.y * d.y + colorIntrinsics.w);
}`;
