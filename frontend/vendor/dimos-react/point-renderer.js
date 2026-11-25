// deno:https://raw.githubusercontent.com/jeff-hykin/dimos-react/v0.3.11/src/three/point_material.ts
import * as THREE2 from "three";

// deno:https://raw.githubusercontent.com/jeff-hykin/dimos-react/v0.3.11/src/three/gradients.ts
import * as THREE from "three";

// deno:https://raw.githubusercontent.com/jeff-hykin/dimos-react/v0.3.11/src/colormaps.ts
var RAMPS = {
  // MemWorld's height ramp: purple, blue, cyan, mint
  memworld: [
    [
      0,
      "#6f15b3"
    ],
    [
      1 / 3,
      "#1b54f8"
    ],
    [
      2 / 3,
      "#1cd0f2"
    ],
    [
      1,
      "#90f690"
    ]
  ],
  // Turbo, starting at its blue (the floor is usually the lowest band)
  turbo: [
    [
      0,
      "#3e5fd8"
    ],
    [
      0.2,
      "#4675ed"
    ],
    [
      0.3,
      "#39a2fc"
    ],
    [
      0.4,
      "#1bcfd4"
    ],
    [
      0.5,
      "#24eca6"
    ],
    [
      0.6,
      "#61fc6c"
    ],
    [
      0.7,
      "#a4fc3b"
    ],
    [
      0.8,
      "#d1e834"
    ],
    [
      0.9,
      "#f3c63a"
    ],
    [
      1,
      "#fe9b2d"
    ]
  ],
  viridis: [
    [
      0,
      "#440154"
    ],
    [
      0.25,
      "#3b528b"
    ],
    [
      0.5,
      "#21918c"
    ],
    [
      0.75,
      "#5ec962"
    ],
    [
      1,
      "#fde725"
    ]
  ],
  magma: [
    [
      0,
      "#000004"
    ],
    [
      0.25,
      "#51127c"
    ],
    [
      0.5,
      "#b73779"
    ],
    [
      0.75,
      "#fc8961"
    ],
    [
      1,
      "#fcfdbf"
    ]
  ],
  plasma: [
    [
      0,
      "#0d0887"
    ],
    [
      0.25,
      "#7e03a8"
    ],
    [
      0.5,
      "#cc4778"
    ],
    [
      0.75,
      "#f89540"
    ],
    [
      1,
      "#f0f921"
    ]
  ],
  ice: [
    [
      0,
      "#0b1d3a"
    ],
    [
      0.35,
      "#1f5f9e"
    ],
    [
      0.7,
      "#7fc8f8"
    ],
    [
      1,
      "#f4fbff"
    ]
  ],
  sunset: [
    [
      0,
      "#1a1046"
    ],
    [
      0.3,
      "#7b2d7a"
    ],
    [
      0.6,
      "#e0565b"
    ],
    [
      0.85,
      "#f6a04d"
    ],
    [
      1,
      "#fde39b"
    ]
  ],
  grayscale: [
    [
      0,
      "#1a1a1a"
    ],
    [
      1,
      "#f2f2f2"
    ]
  ]
};
var GRADIENTS = Object.keys(RAMPS);
var DEFAULT_GRADIENT = "memworld";
function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [
    value >> 16 & 255,
    value >> 8 & 255,
    value & 255
  ];
}
var PALETTES = {
  aurora: {
    label: "Aurora (purple \u2192 blue \u2192 cyan \u2192 green)",
    colors: [
      "#a05cf0",
      "#5a86f2",
      "#3ed4e0",
      "#6ee68c"
    ]
  },
  ember: {
    label: "Ember (gold \u2192 orange \u2192 red)",
    colors: [
      "#f2c64e",
      "#f08c4c",
      "#e8565e"
    ]
  },
  rose: {
    label: "Rose (pink \u2192 blush \u2192 white)",
    colors: [
      "#f264b0",
      "#f2a6cc",
      "#f6e8ee"
    ]
  }
};
var PALETTE_NAMES = Object.keys(PALETTES);
var DEFAULT_PALETTE = "aurora";
var DEFAULT_PERIOD = 9;
function isPalette(name) {
  return Object.hasOwn(PALETTES, name);
}
function paletteAt(name, phase) {
  const colors = (PALETTES[name] ?? PALETTES[DEFAULT_PALETTE]).colors.map(hexToRgb);
  const wrapped = phase - Math.floor(phase);
  const along = (1 - Math.abs(2 * wrapped - 1)) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(along));
  const mix = along - index;
  const [a, b] = [
    colors[index],
    colors[index + 1]
  ];
  return [
    a[0] + (b[0] - a[0]) * mix,
    a[1] + (b[1] - a[1]) * mix,
    a[2] + (b[2] - a[2]) * mix
  ];
}
function sampleGradient(name, t) {
  if (isPalette(name)) {
    return paletteAt(name, t);
  }
  const stops = RAMPS[name] ?? RAMPS[DEFAULT_GRADIENT];
  const clamped = Math.min(1, Math.max(0, t));
  for (let index = 1; index < stops.length; index++) {
    const [position, hex] = stops[index];
    if (clamped <= position) {
      const [lastPosition, lastHex] = stops[index - 1];
      const mix = (clamped - lastPosition) / (position - lastPosition || 1);
      const a = hexToRgb(lastHex);
      const b = hexToRgb(hex);
      return [
        a[0] + (b[0] - a[0]) * mix,
        a[1] + (b[1] - a[1]) * mix,
        a[2] + (b[2] - a[2]) * mix
      ];
    }
  }
  return hexToRgb(stops[stops.length - 1][1]);
}

// deno:https://raw.githubusercontent.com/jeff-hykin/dimos-react/v0.3.11/src/three/gradients.ts
var textures = /* @__PURE__ */ new Map();
function gradientTexture(name) {
  let texture = textures.get(name);
  if (!texture) {
    const data = new Uint8Array(256 * 4);
    const cyclic = isPalette(name);
    for (let index = 0; index < 256; index++) {
      const [r, g, b] = sampleGradient(name, cyclic ? (index + 0.5) / 256 : index / 255);
      data.set([
        r,
        g,
        b,
        255
      ], index * 4);
    }
    texture = new THREE.DataTexture(data, 256, 1);
    if (cyclic) {
      texture.wrapS = THREE.RepeatWrapping;
    }
    texture.colorSpace = THREE.NoColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    textures.set(name, texture);
  }
  return texture;
}

// deno:https://raw.githubusercontent.com/jeff-hykin/dimos-react/v0.3.11/src/three/point_material.ts
var splatBackground = new THREE2.Color().setRGB(0, 0, 0, THREE2.NoColorSpace);
var POINT_STYLES = {
  voxel: {
    id: 2,
    label: "Cubes",
    define: "VOXEL",
    about: "lit cubes on the voxel grid"
  },
  splat: {
    id: 3,
    label: "Glow",
    define: "SPLAT",
    about: "soft gaussian splats fading into the background with distance"
  },
  disc: {
    id: 0,
    label: "Spheres",
    define: null,
    about: "lit spheres"
  },
  square: {
    id: 1,
    label: "Squares",
    define: null,
    about: "flat squares, the cheapest"
  }
};
var CUBE_SHADES = {
  soft: {
    id: 0,
    label: "Soft",
    about: "gentle wrap-around light, no dark faces"
  },
  sky: {
    id: 1,
    label: "Sky",
    about: "lit from above: tops bright, sides mid, undersides dim"
  },
  outline: {
    id: 2,
    label: "Outlined",
    about: "flat color with thin dark edges"
  },
  bevel: {
    id: 3,
    label: "Beveled",
    about: "soft light with faces darkening toward their edges"
  },
  memworld: {
    id: 4,
    label: "Contrast",
    about: "strong per-face light"
  }
};
var DEFAULT_LOOK = {
  style: "voxel",
  size: 0.05,
  colorMode: "height",
  gradient: "memworld",
  axis: 2,
  rangeMin: null,
  rangeMax: null,
  solid: "#ffffff",
  opacity: 1,
  cubeShade: "soft",
  nearShrink: 0
};
var COLOR = {
  height: 0,
  intensity: 1,
  range: 2,
  solid: 3
};
var VIEW_LIGHT = new THREE2.Vector3(2, 4, 3).normalize();
var vertexShader = (
  /* glsl */
  `
uniform float uSize;
uniform float uPxPerMeter;
uniform float uMinPx;
uniform float uNearShrink;
uniform int uStyle;
uniform int uColorMode;
uniform int uAxis;
uniform vec2 uRange;
uniform float uPeriod;
uniform vec3 uSolid;
uniform vec3 uSensor;
uniform float uNow;
uniform float uWindow;
uniform sampler2D uGradient;
uniform float uKeep;
uniform vec3 uClipMin;
uniform vec3 uClipMax;
attribute float aTime;
attribute float aIntensity;
varying vec3 vColor;
varying vec3 vCenter;
varying float vHalf;
varying float vViewDepth;

void main() {
    // attributes are only read when used, so an idle one isn't fetched for every point (10M points are vertex-bound)
#ifdef USE_WINDOW
    if (aTime < uNow - uWindow) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
    }
#endif
    vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
    // the clip box (setClipBox): outside it, nothing is drawn
    if (any(lessThan(world, uClipMin)) || any(greaterThan(world, uClipMax))) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
    }
    vec3 center = uStyle == 2 ? (floor(world / uSize) + 0.5) * uSize : world;
#ifdef USE_INTENSITY
    float value = aIntensity;
#else
    float value = uColorMode == 2 ? distance(world, uSensor) : center[uAxis];
#endif
    // a repeating palette cycles every uPeriod meters (its texture wraps, so the repeat has no seam); a ramp spans uRange
    float t = uPeriod > 0.0 ? fract(value / uPeriod) : clamp((value - uRange.x) / max(1e-6, uRange.y - uRange.x), 0.0, 1.0);
    vColor = uColorMode == 3 ? uSolid : texture2D(uGradient, vec2(t, 0.5)).rgb;
    vec4 mv = viewMatrix * vec4(center, 1.0);
    float depth = max(1e-3, -mv.z);
    // a cube's silhouette can reach sqrt(3)/2 of its edge from the center; a splat's soft edge needs room too
    float px = uSize * uPxPerMeter / depth * (uStyle == 2 ? 1.8 : uStyle == 3 ? 1.8 : 1.0);
    // inside uNearShrink a point keeps the screen size it had there, so it shrinks in the world as the camera nears
    if (uNearShrink > 0.0) px *= min(1.0, depth / uNearShrink);
#ifdef SPLAT
    // over the splat budget, a stable random subset is drawn: blended splats are fill-bound, and where a map is dense
    // enough to exceed the budget its splats already overlap so much that the dropped ones don't change the picture
    if (fract(sin(float(gl_VertexID) * 12.9898) * 43758.5453) > uKeep) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
    }
    vViewDepth = depth;
#endif
    gl_Position = projectionMatrix * mv;
    // a splat right in front of the camera would be a screen-filling blob (and the most expensive fragment work)
    gl_PointSize = clamp(px, uMinPx, uStyle == 3 ? 64.0 : 512.0);
    vCenter = center;
    vHalf = 0.5 * gl_PointSize / uPxPerMeter * depth;
}
`
);
var fragmentShader = (
  /* glsl */
  `
uniform float uSize;
uniform int uStyle;
uniform float uOpacity;
uniform vec3 uLightWorld;
uniform vec2 uFog;
uniform vec3 uBackground;
uniform int uCubeShade;
// view-space light direction, MemWorld's normalize(2, 4, 3)
const vec3 LIGHT = vec3(0.3713907, 0.7427814, 0.5570860);
varying vec3 vColor;
varying vec3 vCenter;
varying float vHalf;
varying float vViewDepth;

void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    p.y = -p.y;
#if defined(SPLAT)
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    float alpha = exp(-r2 * 3.2) * 0.85 * uOpacity;
    float fog = smoothstep(uFog.x, uFog.y, vViewDepth);
    vec3 color = mix(vColor * 1.15, uBackground, fog * 0.85);
    gl_FragColor = vec4(color * alpha, alpha);
#elif !defined(VOXEL)
    // disc / square never write depth themselves, so the GPU's early depth test keeps working for them
    if (uStyle == 1) {
        gl_FragColor = vec4(vColor, uOpacity);
        return;
    }
    // a ball: the sphere normal the disc implies, lit like MemWorld's voxel_sprites.js
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    vec3 n = vec3(p, sqrt(1.0 - r2));
    gl_FragColor = vec4(vColor * (0.45 + 0.75 * max(dot(n, LIGHT), 0.0)), uOpacity);
#else
    // voxel: cast this fragment's camera ray at the cube around vCenter
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 onSprite = vCenter + right * p.x * vHalf + up * p.y * vHalf;
    vec3 dir = normalize(onSprite - cameraPosition);
    vec3 h = vec3(0.5 * uSize);
    vec3 inv = 1.0 / dir;
    vec3 t0 = (vCenter - h - cameraPosition) * inv;
    vec3 t1 = (vCenter + h - cameraPosition) * inv;
    vec3 tMin = min(t0, t1);
    vec3 tMax = max(t0, t1);
    float tNear = max(max(tMin.x, tMin.y), tMin.z);
    float tFar = min(min(tMax.x, tMax.y), tMax.z);
    if (tNear > tFar || tFar < 0.0) discard;
    vec3 hit = cameraPosition + dir * tNear;
    vec3 local = (hit - vCenter) / h;
    vec3 a = abs(local);
    vec3 normal;
    vec2 face;
    if (a.x >= a.y && a.x >= a.z) { normal = vec3(sign(local.x), 0.0, 0.0); face = local.yz; }
    else if (a.y >= a.z) { normal = vec3(0.0, sign(local.y), 0.0); face = local.xz; }
    else { normal = vec3(0.0, 0.0, sign(local.z)); face = local.xy; }
    float rim = max(abs(face.x), abs(face.y));
    float ndl = dot(normal, uLightWorld);
    float light;
    if (uCubeShade == 0) {
        // wrap lighting: the face away from the light still keeps most of its color
        light = 0.66 + 0.36 * (0.5 + 0.5 * ndl) - 0.06 * smoothstep(0.9, 1.0, rim);
    } else if (uCubeShade == 1) {
        // hemisphere light from world up (z), with a small side bias so neighbouring side faces still differ
        light = normal.z > 0.5 ? 1.02 : normal.z < -0.5 ? 0.62 : 0.8 + 0.06 * (normal.x + 0.5 * normal.y);
        light -= 0.05 * smoothstep(0.9, 1.0, rim);
    } else if (uCubeShade == 2) {
        light = (0.9 + 0.08 * ndl) * (1.0 - 0.5 * smoothstep(0.88, 0.93, rim));
    } else if (uCubeShade == 3) {
        light = (0.72 + 0.3 * (0.5 + 0.5 * ndl)) * (1.0 - 0.22 * smoothstep(0.45, 1.0, rim));
    } else {
        // per-face light (MemWorld's cube faces): the view-space light turned into world space once per draw, on the CPU
        light = (0.42 + 0.72 * max(ndl, 0.0)) * (1.0 - 0.18 * smoothstep(0.86, 0.99, rim));
    }
    gl_FragColor = vec4(vColor * light, uOpacity);
#endif
}
`
);
var focusDistance = {
  value: 10
};
function makePointMaterial(pixelsPerMeter) {
  const material = new THREE2.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uSize: {
        value: 0.05
      },
      uPxPerMeter: pixelsPerMeter,
      uMinPx: {
        value: 1.5
      },
      uNearShrink: {
        value: 0
      },
      uStyle: {
        value: 0
      },
      uColorMode: {
        value: 0
      },
      uAxis: {
        value: 2
      },
      uRange: {
        value: new THREE2.Vector2(0, 2)
      },
      uPeriod: {
        value: 0
      },
      uSolid: {
        value: new THREE2.Color().setRGB(1, 1, 1, THREE2.NoColorSpace)
      },
      uSensor: {
        value: new THREE2.Vector3()
      },
      uNow: {
        value: 0
      },
      uWindow: {
        value: -1
      },
      uOpacity: {
        value: 1
      },
      uGradient: {
        value: gradientTexture("memworld")
      },
      uLightWorld: {
        value: new THREE2.Vector3()
      },
      uKeep: {
        value: 1
      },
      uFog: {
        value: new THREE2.Vector2(10, 40)
      },
      uBackground: {
        value: splatBackground
      },
      uCubeShade: {
        value: 0
      },
      uClipMin: {
        value: new THREE2.Vector3(-1e9, -1e9, -1e9)
      },
      uClipMax: {
        value: new THREE2.Vector3(1e9, 1e9, 1e9)
      }
    },
    defines: {}
  });
  const light = material.uniforms.uLightWorld.value;
  material.onBeforeRender = (_renderer, _scene, camera) => {
    light.copy(VIEW_LIGHT).transformDirection(camera.matrixWorld);
    const focus = focusDistance.value;
    material.uniforms.uFog.value.set(focus * 0.6, focus * 2.2);
  };
  return material;
}
function applyLook(material, partial, range) {
  const look = {
    ...DEFAULT_LOOK,
    ...partial
  };
  const uniforms = material.uniforms;
  uniforms.uCubeShade.value = CUBE_SHADES[look.cubeShade]?.id ?? 0;
  uniforms.uSize.value = Math.max(1e-3, look.size);
  uniforms.uNearShrink.value = Math.max(0, look.nearShrink ?? 0);
  const style = POINT_STYLES[look.style] ?? POINT_STYLES.disc;
  uniforms.uStyle.value = style.id;
  const wanted = /* @__PURE__ */ new Set();
  if (style.define) {
    wanted.add(style.define);
  }
  if (look.colorMode === "intensity") {
    wanted.add("USE_INTENSITY");
  }
  if (uniforms.uWindow.value >= 0) {
    wanted.add("USE_WINDOW");
  }
  const defines = material.defines;
  const current = Object.keys(defines);
  if (current.length !== wanted.size || current.some((name) => !wanted.has(name))) {
    for (const name of current) {
      delete defines[name];
    }
    for (const name of wanted) {
      defines[name] = 1;
    }
    material.needsUpdate = true;
  }
  uniforms.uColorMode.value = COLOR[look.colorMode] ?? 0;
  uniforms.uAxis.value = look.axis;
  uniforms.uRange.value.set(look.rangeMin ?? range[0], look.rangeMax ?? range[1]);
  uniforms.uSolid.value.setStyle(look.solid, THREE2.NoColorSpace);
  uniforms.uOpacity.value = look.opacity;
  uniforms.uGradient.value = gradientTexture(look.gradient);
  uniforms.uPeriod.value = look.colorMode === "height" && isPalette(look.gradient) ? Math.max(0.05, look.period ?? DEFAULT_PERIOD) : 0;
  const splat = look.style === "splat";
  material.transparent = splat || look.opacity < 1;
  material.depthWrite = !splat && look.opacity >= 1;
  material.blending = splat ? THREE2.CustomBlending : THREE2.NormalBlending;
  material.blendSrc = THREE2.OneFactor;
  material.blendDst = THREE2.OneMinusSrcAlphaFactor;
}
export {
  applyLook,
  makePointMaterial
};
