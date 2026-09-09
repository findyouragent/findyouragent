import { useEffect, useRef } from 'react';

/* Draws transparent contour lines behind the application content.
 * The shader math is from MengTo/threeui's TopoField (MIT). */

const VERT = `
attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform float u_time;
uniform float u_dpr;
uniform float u_topo;
uniform vec3 u_ground;

vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

void main() {
  // CSS pixels, not normalised screen space. Anchoring the noise to the
  // viewport meant every resize — and every browser zoom step, which changes
  // devicePixelRatio — restretched the whole field, so zooming looked like
  // the background animating. In CSS-pixel space the surface holds still and
  // zoom simply shows more or less of it, which is how a drafting surface
  // behaves. 0.00156 reproduces the previous density at 1440x900.
  vec2 cssPx = gl_FragCoord.xy / u_dpr;

  vec2 noisePos = cssPx * 0.00156 + vec2(u_time * 0.015, u_time * 0.025);
  float n = snoise(noisePos) * 0.5 + 0.5;
  float triangleWave = abs(fract(n * 10.0) - 0.5) * 2.0;
  float topoLines = smoothstep(0.02, 0.0, triangleWave) * u_topo;

  // Opaque, and the ground is painted here rather than shown through.
  //
  // Two attempts at a transparent canvas both failed on real hardware while
  // looking correct in a software renderer: the compositing of a translucent
  // WebGL surface over the page is where the driver differences live. So the
  // canvas stops being translucent. It draws --bg-0 itself and adds the lines
  // on top, which is what the page looked like anyway, with no alpha for a
  // driver to interpret.
  float a = clamp(topoLines, 0.0, 1.0);
  gl_FragColor = vec4(u_ground + vec3(a), 1.0);
}
`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * @param topo  alpha of the contour lines, 0-1
 *
 * A contrast budget, not a taste setting. Where a contour crosses text the
 * line IS the background, and the topbar, stat readout and tab row are all
 * transparent over this field. At the source's 0.45 --text-dim measured
 * 3.11:1 against a crossing line, under the 4.5 floor.
 */
export default function TopoBackground({ topo = 0.07 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const gl = canvas.getContext('webgl', {
      alpha: false, antialias: false, depth: false,
    });
    // No WebGL is not a failure state: the page simply keeps the flat ground
    // it already had, and nothing below this line ever runs.
    if (!gl) return undefined;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return undefined;

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return undefined;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const positionLoc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(program, 'u_time');
    const uDpr = gl.getUniformLocation(program, 'u_dpr');
    gl.uniform1f(gl.getUniformLocation(program, 'u_topo'), topo);
    // Read the ground from the token so the canvas never drifts from the page.
    const ground = getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim();
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(ground);
    const rgb = m ? [1, 2, 3].map((i) => parseInt(m[i], 16) / 255) : [0.043, 0.055, 0.067];
    gl.uniform3f(gl.getUniformLocation(program, 'u_ground'), rgb[0], rgb[1], rgb[2]);

    function resize() {
      // Capped at 2: past that the extra fragments buy nothing visible on a
      // field of hairlines and cost real milliseconds on a 3x phone.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.floor(window.innerWidth * dpr);
      const h = Math.floor(window.innerHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      // Pushed EVERY time, never gated behind the size check. Uniforms belong
      // to a program, and StrictMode remounts this effect: the second mount
      // compiles a fresh program while the canvas already has its final size,
      // so an early return here left u_dpr at 0 on the live program. Dividing
      // gl_FragCoord by 0 flattened the field to a plain wash, which is why it
      // only appeared once a zoom changed the dimensions.
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1f(uDpr, dpr);
    }

    let seconds = 0;
    function draw(t) {
      seconds = t;
      gl.uniform1f(uTime, seconds);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // Resizing wipes the drawing buffer, so redraw in the same turn rather
    // than waiting for the next frame to repaint an empty canvas.
    function onResize() {
      resize();
      draw(seconds);
    }

    resize();
    window.addEventListener('resize', onResize);

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still) {
      // The field is the point; the drift is the decoration. Readers who asked
      // for less motion still get the surface, held at one frame.
      draw(0);
      return () => window.removeEventListener('resize', onResize);
    }

    draw(0);

    let frame = 0;
    const start = performance.now();
    function loop(now) {
      resize();
      draw((now - start) * 0.001);
      frame = requestAnimationFrame(loop);
    }
    frame = requestAnimationFrame(loop);

    // A background nobody is looking at should not be costing them battery.
    function onVisibility() {
      cancelAnimationFrame(frame);
      if (!document.hidden) frame = requestAnimationFrame(loop);
    }
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      // Deliberately NOT loseContext(). StrictMode runs effects
      // mount -> cleanup -> mount in development, and a lost context is
      // permanent: getContext() hands the same dead object back on the second
      // mount, so the canvas never draws again and getContextAttributes()
      // returns null. Stopping the loop is the whole of the cleanup; the
      // context goes when the canvas does.
    };
  }, [topo]);

  return <canvas ref={canvasRef} className="topo-bg" aria-hidden="true" />;
}
