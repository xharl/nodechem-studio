/**
 * The lazy WebGL2 isosurface viewport.
 *
 * Two promises this module keeps, because both are easy to break and hard to
 * notice:
 *
 * 1. **It is lazy.** Importing it creates nothing: no canvas context, no
 *    shader, no buffers. `createSurfaceViewer` builds the DOM (a canvas and a
 *    numbers table) and stops there. The GL context is created on the first
 *    call that actually has a mesh to draw. A user who never opens a surface
 *    pays nothing, and the app's start-up path does not depend on a GPU being
 *    present.
 *
 * 2. **A missing GPU is stated, not blank.** If `getContext('webgl2')` returns
 *    null — an old iGPU, a VM, a software rasteriser that refused — the panel
 *    shows `surface view unavailable: no WebGL2 context` and keeps the numbers
 *    (triangle count per lobe, isovalue, grid) visible. A blank canvas would
 *    read as "this orbital has no surface", which is a different and false
 *    claim.
 *
 * Camera maths is a pure function so it can be checked without a GPU: see
 * `cameraMatrices` and `test/volumeViews.test.js`.
 */

import { toStlBinary } from '../shared/marchingCubes.js';

export const NO_WEBGL2_MESSAGE = 'surface view unavailable: no WebGL2 context';
export const SHADER_FAILURE_MESSAGE = 'surface view unavailable: the WebGL2 shaders did not compile';

/** Positive and negative lobe colours, matching the slice palette's hues. */
export const LOBE_COLOURS = Object.freeze({
  positive: [0.85, 0.42, 0.12],
  negative: [0.18, 0.43, 0.84],
});

/* ── pure camera maths ────────────────────────────────────── */

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      let sum = 0;
      for (let at = 0; at < 4; at += 1) sum += a[at * 4 + row] * b[column * 4 + at];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

function perspective(fieldOfView, aspect, near, far) {
  const f = 1 / Math.tan(fieldOfView / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

/**
 * Model-view-projection for an orbit camera.
 *
 * The mesh stays in Å; the camera orbits its centre at `distance`, with `yaw`
 * about the world z axis and `pitch` about the camera's x axis. `rotation` is
 * the 3×3 part applied to normals, so lighting does not depend on the
 * perspective divide.
 */
export function cameraMatrices({
  centre = [0, 0, 0],
  radius = 1,
  yaw = 0.6,
  pitch = 0.35,
  distance = 2.4,
  aspect = 1,
  fieldOfView = Math.PI / 4,
} = {}) {
  const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : 1;
  const eyeDistance = Math.max(safeRadius * 0.5, distance * safeRadius);
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);

  // Rotation: yaw about z, then pitch about x.
  const rotation = new Float32Array([
    cosYaw * cosPitch, sinYaw * cosPitch, -sinPitch,
    -sinYaw, cosYaw, 0,
    cosYaw * sinPitch, sinYaw * sinPitch, cosPitch,
  ]);

  const view = new Float32Array(16);
  // Rotation block.
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      view[column * 4 + row] = rotation[row * 3 + column];
    }
  }
  view[15] = 1;
  // Translate the centre to the origin, then push it away from the camera.
  const eye = [1, 2, 3].map((at) => -(rotation[(at - 1) * 3] * centre[0] + rotation[(at - 1) * 3 + 1] * centre[1] + rotation[(at - 1) * 3 + 2] * centre[2]));
  view[12] = eye[0];
  view[13] = eye[1];
  view[14] = eye[2] - eyeDistance;

  const near = Math.max(0.01, eyeDistance - safeRadius * 4);
  const far = eyeDistance + safeRadius * 8;
  const projection = perspective(fieldOfView, Math.max(0.1, aspect), near, far);
  const mvp = multiply(projection, view);
  return { mvp, rotation, eye: [0, 0, eyeDistance], near, far };
}

/* ── shaders ──────────────────────────────────────────────── */

const VERTEX_SHADER = `#version 300 es
in vec3 aPosition;
in vec3 aNormal;
uniform mat4 uMvp;
uniform mat3 uRotation;
out vec3 vNormal;
out vec3 vEye;
void main() {
  vNormal = uRotation * aNormal;
  vEye = normalize(vNormal);
  gl_Position = uMvp * vec4(aPosition, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vEye;
uniform vec3 uColour;
uniform vec3 uLight;
out vec4 outColour;
void main() {
  vec3 normal = normalize(vNormal);
  if (!gl_FrontFacing) normal = -normal;
  float diffuse = max(dot(normal, normalize(uLight)), 0.0);
  float rim = pow(1.0 - abs(dot(normal, vEye)), 2.0);
  vec3 colour = uColour * (0.34 + 0.66 * diffuse) + vec3(0.22) * rim;
  outColour = vec4(colour, 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'unknown shader error';
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Mount the surface viewport. Nothing GL-related happens until `setMeshes`.
 *
 * @param {HTMLElement} host
 * @param {{doc?: Document, onIsoChange?: (iso: number) => void, interval?: [number, number]}} [options]
 */
export function createSurfaceViewer(host, { doc = globalThis.document, onIsoChange = null, interval = null } = {}) {
  if (!host || !doc) return null;

  const root = el(doc, 'div', 'surface-view');
  const controls = el(doc, 'div', 'surface-controls');

  const isoLabel = el(doc, 'label', 'surface-control');
  isoLabel.append(el(doc, 'span', null, 'Isovalue'));
  const isoInput = el(doc, 'input');
  isoInput.type = 'range';
  isoInput.min = '0.001';
  isoInput.max = '0.2';
  isoInput.step = '0.001';
  isoInput.value = '0.02';
  const isoValue = el(doc, 'output', 'surface-number', '0.020');
  isoLabel.append(isoInput, isoValue);

  const lobeLabel = el(doc, 'div', 'surface-lobes');
  const positiveToggle = el(doc, 'input');
  positiveToggle.type = 'checkbox';
  positiveToggle.checked = true;
  const positiveLabel = el(doc, 'label', 'surface-lobe is-positive');
  positiveLabel.append(positiveToggle, el(doc, 'span', null, '+ lobe'));
  const negativeToggle = el(doc, 'input');
  negativeToggle.type = 'checkbox';
  negativeToggle.checked = true;
  const negativeLabel = el(doc, 'label', 'surface-lobe is-negative');
  negativeLabel.append(negativeToggle, el(doc, 'span', null, '− lobe'));
  lobeLabel.append(positiveLabel, negativeLabel);

  controls.append(isoLabel, lobeLabel);

  const frame = el(doc, 'div', 'surface-frame');
  const canvas = el(doc, 'canvas', 'surface-canvas');
  canvas.width = 360;
  canvas.height = 300;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Isosurface; drag to orbit, wheel to zoom');
  const notice = el(doc, 'p', 'surface-notice');
  notice.hidden = true;
  notice.setAttribute('data-role', 'surface-notice');
  frame.append(canvas, notice);

  const numbers = el(doc, 'dl', 'surface-numbers');
  numbers.setAttribute('data-role', 'surface-numbers');

  const actions = el(doc, 'div', 'surface-actions');
  const pngButton = el(doc, 'button', 'button is-quiet', 'Save PNG');
  pngButton.type = 'button';
  const stlButton = el(doc, 'button', 'button is-quiet', 'Save STL');
  stlButton.type = 'button';
  actions.append(pngButton, stlButton);

  root.append(controls, frame, numbers, actions);
  host.append(root);

  let gl = null;
  let program = null;
  let buffers = { positive: null, negative: null };
  let mesh = { positive: null, negative: null };
  let iso = 0.02;
  let attempt = null;
  let yaw = 0.6;
  let pitch = 0.35;
  let zoom = 2.4;
  let centre = [0, 0, 0];
  let radius = 1;
  let pending = false;

  const setNumbers = () => {
    const rows = [
      ['isovalue', `${iso.toPrecision(3)} a.u.`],
      ['+ lobe', mesh.positive ? `${mesh.positive.triangleCount} triangles` : 'not drawn'],
      ['− lobe', mesh.negative ? `${mesh.negative.triangleCount} triangles` : 'not drawn'],
      ['grid', mesh.positive || mesh.negative ? lastGridLine : 'not evaluated'],
      ['renderer', gl ? 'WebGL2' : (attempt === 'failed' ? 'unavailable' : 'not started')],
    ];
    numbers.replaceChildren(...rows.flatMap(([term, value]) => {
      const dt = el(doc, 'dt', null, term);
      const dd = el(doc, 'dd', null, value);
      dd.setAttribute('data-role', `surface-${term.replace(/[^a-z]/g, '')}`);
      return [dt, dd];
    }));
  };
  let lastGridLine = 'not evaluated';

  const failure = (message) => {
    attempt = 'failed';
    notice.hidden = false;
    notice.textContent = message;
    notice.setAttribute('data-state', 'unavailable');
    canvas.hidden = true;
    setNumbers();
    return null;
  };

  const ensure = () => {
    if (gl) return gl;
    if (attempt === 'failed') return null;
    let context = null;
    try {
      // `preserveDrawingBuffer` so `toDataURL` after a frame is not a black
      // image, which is the classic "PNG export is empty" bug.
      context = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
    } catch {
      context = null;
    }
    if (!context) {
      attempt = 'failed';
      return failure(NO_WEBGL2_MESSAGE);
    }
    try {
      const vertex = compile(context, context.VERTEX_SHADER, VERTEX_SHADER);
      const fragment = compile(context, context.FRAGMENT_SHADER, FRAGMENT_SHADER);
      const created = context.createProgram();
      context.attachShader(created, vertex);
      context.attachShader(created, fragment);
      context.linkProgram(created);
      if (!context.getProgramParameter(created, context.LINK_STATUS)) {
        throw new Error(context.getProgramInfoLog(created) || 'link failed');
      }
      context.deleteShader(vertex);
      context.deleteShader(fragment);
      program = {
        handle: created,
        mvp: context.getUniformLocation(created, 'uMvp'),
        rotation: context.getUniformLocation(created, 'uRotation'),
        colour: context.getUniformLocation(created, 'uColour'),
        light: context.getUniformLocation(created, 'uLight'),
        position: context.getAttribLocation(created, 'aPosition'),
        normal: context.getAttribLocation(created, 'aNormal'),
      };
      gl = context;
      attempt = 'ready';
      return gl;
    } catch (error) {
      attempt = 'failed';
      return failure(`${SHADER_FAILURE_MESSAGE} (${String(error?.message ?? error).slice(0, 200)})`);
    }
  };

  const upload = (hostMesh) => {
    const buffer = { position: gl.createBuffer(), normal: gl.createBuffer(), count: hostMesh.triangleCount * 3 };
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer.position);
    gl.bufferData(gl.ARRAY_BUFFER, hostMesh.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer.normal);
    gl.bufferData(gl.ARRAY_BUFFER, hostMesh.normals, gl.STATIC_DRAW);
    return buffer;
  };

  /**
   * The canvas background, taken from the theme so a light theme does not get a
   * dark viewport. Parsed here because GL wants floats, and a literal colour
   * here would be one of the three themes' palette misfiled.
   */
  const clearColour = () => {
    let raw = '';
    try {
      raw = String(doc.defaultView?.getComputedStyle?.(canvas)?.getPropertyValue?.('--surface-canvas') ?? '').trim();
    } catch {
      raw = '';
    }
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
    if (!match) return [0.05, 0.06, 0.08];
    const digits = match[1].length === 3
      ? match[1].split('').map((character) => character + character).join('')
      : match[1];
    return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16) / 255);
  };

  const resize = () => {
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    const width = Math.max(2, Math.round((canvas.clientWidth || 360) * ratio));
    const height = Math.max(2, Math.round((canvas.clientHeight || 300) * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
    return { width, height };
  };

  const draw = () => {
    if (!ensure()) return false;
    const { width, height } = resize();
    const [clearR, clearG, clearB] = clearColour();
    gl.clearColor(clearR, clearG, clearB, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.useProgram(program.handle);

    const camera = cameraMatrices({
      centre,
      radius,
      yaw,
      pitch,
      distance: zoom,
      aspect: width / height,
    });
    gl.uniformMatrix4fv(program.mvp, false, camera.mvp);
    gl.uniformMatrix3fv(program.rotation, false, camera.rotation);
    gl.uniform3f(program.light, 0.35, 0.55, 0.85);

    const lobes = [
      [mesh.positive, positiveToggle.checked, LOBE_COLOURS.positive],
      [mesh.negative, negativeToggle.checked, LOBE_COLOURS.negative],
    ];
    for (const [lobe, visible, colour] of lobes) {
      if (!lobe || !visible || !lobe.triangleCount) continue;
      gl.uniform3fv(program.colour, colour);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[lobe === mesh.positive ? 'positive' : 'negative'].position);
      gl.enableVertexAttribArray(program.position);
      gl.vertexAttribPointer(program.position, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[lobe === mesh.positive ? 'positive' : 'negative'].normal);
      gl.enableVertexAttribArray(program.normal);
      gl.vertexAttribPointer(program.normal, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, lobe.triangleCount * 3);
    }
    return true;
  };

  const requestDraw = () => {
    if (pending) return;
    pending = true;
    const schedule = globalThis.requestAnimationFrame ?? ((callback) => setTimeout(callback, 0));
    schedule(() => {
      pending = false;
      draw();
    });
  };

  /* ── interaction ─────────────────────────────────────── */

  let drag = null;
  canvas.addEventListener('pointerdown', (event) => {
    drag = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture?.(event.pointerId);
    canvas.dataset.dragging = 'true';
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    yaw += (event.clientX - drag.x) * 0.01;
    pitch = Math.max(-1.45, Math.min(1.45, pitch + (event.clientY - drag.y) * 0.01));
    drag = { x: event.clientX, y: event.clientY };
    requestDraw();
  });
  const endDrag = () => {
    drag = null;
    delete canvas.dataset.dragging;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (drag) endDrag();
  });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoom = Math.max(0.55, Math.min(20, zoom * Math.exp(event.deltaY * 0.0012)));
    requestDraw();
  }, { passive: false });

  isoInput.addEventListener('input', () => {
    iso = Math.abs(Number(isoInput.value)) || 0.001;
    isoValue.textContent = iso.toPrecision(3);
    setNumbers();
    if (onIsoChange) onIsoChange(iso);
    else requestDraw();
  });
  positiveToggle.addEventListener('change', requestDraw);
  negativeToggle.addEventListener('change', () => {
    setNumbers();
    requestDraw();
  });

  const save = async (bytes, name, mime) => {
    const desktop = globalThis.window?.desktop ?? null;
    if (desktop?.saveBinary) {
      await desktop.saveBinary({ suggestedName: name, bytes, mime });
      return true;
    }
    // Browser preview: hand the file to the download machinery instead of
    // pretending it was saved.
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = doc.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  };

  pngButton.addEventListener('click', async () => {
    if (!draw()) return;
    const dataUrl = canvas.toDataURL('image/png');
    const binary = atob(dataUrl.split(',')[1] ?? '');
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
    await save(bytes, 'isosurface.png', 'image/png');
  });

  stlButton.addEventListener('click', async () => {
    const bytes = api.exportStl();
    if (!bytes) return;
    await save(new Uint8Array(bytes), 'isosurface.stl', 'model/stl');
  });

  const api = {
    element: root,
    canvas,
    notice,
    /**
     * Hand the viewer its meshes. This is the first call that may create a GL
     * context: a viewer with nothing to draw never asks for one.
     */
    setMeshes(next, { iso: nextIso = iso, grid = null } = {}) {
      mesh = { positive: next?.positive ?? null, negative: next?.negative ?? null };
      if (Number.isFinite(nextIso) && nextIso > 0) {
        iso = nextIso;
        isoInput.value = String(nextIso);
        isoValue.textContent = nextIso.toPrecision(3);
      }
      if (grid) lastGridLine = grid;
      const bounds = mesh.positive?.bounds ?? mesh.negative?.bounds ?? null;
      if (bounds) {
        centre = [0, 1, 2].map((axis) => (bounds.min[axis] + bounds.max[axis]) / 2);
        radius = Math.max(0.5, Math.hypot(
          bounds.max[0] - bounds.min[0],
          bounds.max[1] - bounds.min[1],
          bounds.max[2] - bounds.min[2],
        ) / 2);
      }
      negativeToggle.disabled = !mesh.negative;
      setNumbers();
      if (!mesh.positive && !mesh.negative) {
        notice.hidden = false;
        notice.textContent = 'no surface at this isovalue: every grid value is inside the range';
        notice.setAttribute('data-state', 'empty');
        canvas.hidden = !gl;
        return null;
      }
      notice.hidden = true;
      canvas.hidden = false;
      if (!ensure()) return null;
      for (const key of ['positive', 'negative']) {
        if (buffers[key]) {
          gl.deleteBuffer(buffers[key].position);
          gl.deleteBuffer(buffers[key].normal);
          buffers[key] = null;
        }
        if (mesh[key] && mesh[key].triangleCount) buffers[key] = upload(mesh[key]);
      }
      draw();
      return { triangles: (mesh.positive?.triangleCount ?? 0) + (mesh.negative?.triangleCount ?? 0) };
    },
    setIso(next) {
      const value = Math.abs(Number(next));
      if (!Number.isFinite(value) || value <= 0) return;
      iso = value;
      isoInput.value = String(value);
      isoValue.textContent = value.toPrecision(3);
      setNumbers();
    },
    setVisible({ positive = true, negative = true } = {}) {
      positiveToggle.checked = positive;
      negativeToggle.checked = negative;
      requestDraw();
    },
    setView({ yaw: nextYaw = yaw, pitch: nextPitch = pitch, zoom: nextZoom = zoom } = {}) {
      yaw = nextYaw;
      pitch = nextPitch;
      zoom = nextZoom;
      requestDraw();
    },
    /** `'ready' | 'failed' | null` — null until a context is asked for. */
    get status() {
      return attempt;
    },
    get message() {
      return notice.hidden ? '' : notice.textContent;
    },
    get triangles() {
      return (mesh.positive?.triangleCount ?? 0) + (mesh.negative?.triangleCount ?? 0);
    },
    /** PNG data URL of the last frame, or `null` when GL never started. */
    pngDataUrl() {
      if (!draw()) return null;
      return canvas.toDataURL('image/png');
    },
    /** Binary STL of both visible lobes, or `null` when there is nothing to write. */
    exportStl() {
      const lobes = [mesh.positive, mesh.negative].filter((lobe) => lobe && lobe.triangleCount);
      if (!lobes.length) return null;
      const positions = new Float32Array(lobes.reduce((total, lobe) => total + lobe.positions.length, 0));
      let offset = 0;
      for (const lobe of lobes) {
        positions.set(lobe.positions, offset);
        offset += lobe.positions.length;
      }
      return toStlBinary({ positions, triangleCount: positions.length / 9 }, {
        header: `NodeChem Studio isosurface, iso ${iso.toPrecision(3)}`,
      });
    },
    async savePng() {
      const dataUrl = this.pngDataUrl();
      if (!dataUrl) return false;
      const binary = atob(dataUrl.split(',')[1] ?? '');
      const bytes = new Uint8Array(binary.length);
      for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
      return save(bytes, 'isosurface.png', 'image/png');
    },
    async saveStl() {
      const bytes = this.exportStl();
      if (!bytes) return false;
      return save(new Uint8Array(bytes), 'isosurface.stl', 'model/stl');
    },
    render: requestDraw,
    destroy() {
      if (gl) {
        for (const key of ['positive', 'negative']) {
          if (buffers[key]) {
            gl.deleteBuffer(buffers[key].position);
            gl.deleteBuffer(buffers[key].normal);
          }
        }
        if (program) gl.deleteProgram(program.handle);
        const lose = gl.getExtension('WEBGL_lose_context');
        lose?.loseContext();
        gl = null;
      }
      root.remove();
    },
  };

  setNumbers();
  return api;
}
