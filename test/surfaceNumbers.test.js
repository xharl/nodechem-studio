import { describe, expect, it } from 'vitest';

import { createSurfaceViewer } from '../src/renderer/surfaceViewer.js';

/**
 * Issue #156: the isosurface numbers said "renderer not started" while the mesh
 * was on the canvas, because the row was written when the mesh was built (before
 * the WebGL context existed) and never refreshed when it came up.
 *
 * There is no canvas in this container, so the test supplies the two things the
 * viewer actually touches — a document that can build elements and a context
 * object that answers the GL calls it makes. That is enough to exercise the
 * state transition the bug was about; it is not a claim that the shaders
 * compile on a real driver.
 */

function shimDocument({ context }) {
  const make = (tag) => {
    const node = {
      tagName: tag,
      className: '',
      textContent: '',
      hidden: false,
      dataset: {},
      attributes: {},
      children: [],
      value: '',
      checked: false,
      disabled: false,
      width: 0,
      height: 0,
      style: {},
      append(...kids) { node.children.push(...kids.filter(Boolean)); },
      replaceChildren(...kids) { node.children = kids.filter(Boolean); },
      setAttribute(name, value) { node.attributes[name] = String(value); },
      getAttribute(name) { return node.attributes[name] ?? null; },
      addEventListener() {},
      removeEventListener() {},
      getContext() { return context; },
      toDataURL() { return 'data:image/png;base64,'; },
      getBoundingClientRect() { return { width: 360, height: 300, left: 0, top: 0 }; },
    };
    return node;
  };
  return {
    createElement: make,
    defaultView: {
      devicePixelRatio: 1,
      getComputedStyle: () => ({ getPropertyValue: () => '#101418' }),
    },
  };
}

/** The smallest object that satisfies the calls the viewer makes on a context. */
function stubContext() {
  const noop = () => {};
  return {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TRIANGLES: 8,
    DEPTH_TEST: 9,
    CULL_FACE: 10,
    BACK: 11,
    COLOR_BUFFER_BIT: 12,
    DEPTH_BUFFER_BIT: 13,
    createShader: () => ({}),
    shaderSource: noop,
    compileShader: noop,
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: noop,
    createProgram: () => ({}),
    attachShader: noop,
    linkProgram: noop,
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: noop,
    getUniformLocation: () => ({}),
    getAttribLocation: () => 0,
    createBuffer: () => ({}),
    deleteBuffer: noop,
    bindBuffer: noop,
    bufferData: noop,
    useProgram: noop,
    enable: noop,
    disable: noop,
    depthFunc: noop,
    cullFace: noop,
    viewport: noop,
    clearColor: noop,
    clear: noop,
    enableVertexAttribArray: noop,
    vertexAttribPointer: noop,
    drawArrays: noop,
    uniformMatrix4fv: noop,
    uniformMatrix3fv: noop,
    uniform3fv: noop,
    uniform3f: noop,
  };
}

function findRow(numbers, role) {
  const terms = numbers.children.filter((child) => child.tagName === 'dt');
  const values = numbers.children.filter((child) => child.tagName === 'dd');
  const at = terms.findIndex((term) => term.textContent === role);
  return at === -1 ? null : values[at].textContent;
}

function mount(context) {
  const doc = shimDocument({ context });
  const host = doc.createElement('div');
  const viewer = createSurfaceViewer(host, { doc });
  const numbers = host.children.at(-1).children.find(
    (child) => child.getAttribute('data-role') === 'surface-numbers',
  );
  return { viewer, numbers, host };
}

const mesh = {
  positive: {
    triangleCount: 12,
    positions: new Float32Array(12 * 9),
    normals: new Float32Array(12 * 9),
    bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
  },
  negative: null,
};

describe('the isosurface number row', () => {
  it('reports WebGL2 once the renderer starts, not "not started"', () => {
    const { viewer, numbers } = mount(stubContext());
    expect(viewer).not.toBeNull();
    viewer.setMeshes(mesh, { iso: 0.16, grid: '24×24×24 at 0.079 Å' });

    expect(findRow(numbers, 'isovalue')).toBe('0.160 a.u.');
    expect(findRow(numbers, '+ lobe')).toBe('12 triangles');
    expect(findRow(numbers, 'grid')).toBe('24×24×24 at 0.079 Å');
    // The bug: this read "not started" while the mesh was already drawn.
    expect(findRow(numbers, 'renderer')).toBe('WebGL2');
  });

  it('says unavailable when there is no context, and keeps the numbers', () => {
    const { viewer, numbers } = mount(null);
    viewer.setMeshes(mesh, { iso: 0.16, grid: '24×24×24 at 0.079 Å' });

    expect(findRow(numbers, 'renderer')).toBe('unavailable');
    expect(findRow(numbers, '+ lobe')).toBe('12 triangles');
    expect(findRow(numbers, 'isovalue')).toBe('0.160 a.u.');
  });

  it('never says "not started" while a mesh is present', () => {
    const { viewer, numbers } = mount(stubContext());
    viewer.setMeshes(mesh, { iso: 0.05, grid: 'g' });
    viewer.setMeshes(mesh, { iso: 0.08, grid: 'g' });
    expect(findRow(numbers, 'renderer')).not.toBe('not started');
    expect(findRow(numbers, 'isovalue')).toBe('0.0800 a.u.');
  });
});
