/* 极简 3D 皮肤预览：正交投影 + canvas 仿射贴图，零依赖 */
(function () {
  const PARTS = [
    // name, size[w,h,d], pos[center x,y,z], uv[u,v], inflate
    { n: 'head', size: [8, 8, 8], pos: [0, 28, 0], uv: [0, 0] },
    { n: 'body', size: [8, 12, 4], pos: [0, 18, 0], uv: [16, 16] },
    { n: 'armL', size: [4, 12, 4], pos: [-6, 18, 0], uv: [32, 48] },
    { n: 'armR', size: [4, 12, 4], pos: [6, 18, 0], uv: [40, 16] },
    { n: 'legL', size: [4, 12, 4], pos: [-2, 6, 0], uv: [0, 16] },
    { n: 'legR', size: [4, 12, 4], pos: [2, 6, 0], uv: [16, 48] },
    // 外层（帽子/衣服/袖/裤），1.8+ 才有的 overlay
    { n: 'head2', size: [8.5, 8.5, 8.5], pos: [0, 28, 0], uv: [32, 0] },
    { n: 'body2', size: [8.5, 12.5, 4.5], pos: [0, 18, 0], uv: [16, 32] },
    { n: 'armL2', size: [4.5, 12.5, 4.5], pos: [-6, 18, 0], uv: [48, 48] },
    { n: 'armR2', size: [4.5, 12.5, 4.5], pos: [6, 18, 0], uv: [40, 32] },
    { n: 'legL2', size: [4.5, 12.5, 4.5], pos: [-2, 6, 0], uv: [0, 32] },
    { n: 'legR2', size: [4.5, 12.5, 4.5], pos: [2, 6, 0], uv: [0, 48] },
  ];

  // 每个面的 UV 偏移（相对部件 uv），按 Minecraft 皮肤展开
  function faces(w, h, d, u, v) {
    const P = (x, y, ww, hh) => ({ sx: x, sy: y, sw: ww, sh: hh });
    return [
      { k: 'top', uv: P(u + d, v, w, d), n: [0, 1, 0], shade: 1.0 },
      { k: 'bottom', uv: P(u + d + w, v, w, d), n: [0, -1, 0], shade: 0.5 },
      { k: 'right', uv: P(u, v + d, d, h), n: [1, 0, 0], shade: 0.72 },
      { k: 'front', uv: P(u + d, v + d, w, h), n: [0, 0, 1], shade: 0.88 },
      { k: 'left', uv: P(u + d + w, v + d, d, h), n: [-1, 0, 0], shade: 0.72 },
      { k: 'back', uv: P(u + d + w + d, v + d, w, h), n: [0, 0, -1], shade: 0.82 },
    ];
  }

  function rot(p, yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    let x = p[0] * cy + p[2] * sy;
    let z = -p[0] * sy + p[2] * cy;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const y = p[1] * cp - z * sp;
    z = p[1] * sp + z * cp;
    return [x, y, z];
  }

  function faceCorners(size, center, normal) {
    const [w, h, d] = size.map((v) => v / 2);
    const [cx, cy, cz] = center;
    const signs = {
      top: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]],
      bottom: [[-1, -1, 1], [1, -1, 1], [1, -1, -1], [-1, -1, -1]],
      front: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
      back: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]],
      right: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]],
      left: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]],
    };
    return signs[normal].map((s) => [cx + s[0] * w, cy + s[1] * h, cz + s[2] * d]);
  }

  function render(canvas, tex, opts = {}) {
    const yaw = opts.yaw ?? 0.6;
    const pitch = opts.pitch ?? 0.18;
    const zoom = opts.zoom ?? 1;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const scale = ((H * 0.88) / 34) * zoom;
    const cx = W / 2, cy = H * 0.5 + 10 * scale;
    const legacy = tex.height < (tex.width * 3) / 4;

    const tris = [];
    for (const part of PARTS) {
      if (legacy && part.n.endsWith('2')) continue;
      const [w, h, d] = part.size;
      const fs = faces(w, h, d, part.uv[0], part.uv[1]);
      for (const f of fs) {
        const corners = faceCorners(part.size, part.pos, f.k);
        const rp = corners.map((p) => rot(p, yaw, pitch));
        const depth = rp.reduce((a, p) => a + p[2], 0) / 4;
        const normal = rot(f.n, yaw, pitch);
        const facing = normal[2];
        tris.push({ part, f, rp, depth, facing });
      }
    }
    function paint(list) {
      for (const t of list) {
        if (t.facing > 0.02) continue;
        const [p0, p1, , p3] = t.rp;
        const ax = (p1[0] - p0[0]) * scale, ay = -(p1[1] - p0[1]) * scale;
        const bx = (p3[0] - p0[0]) * scale, by = -(p3[1] - p0[1]) * scale;
        const ox = cx + p0[0] * scale, oy = cy - p0[1] * scale;
        const { sx, sy, sw, sh } = t.f.uv;
        if (sw <= 0 || sh <= 0) continue;
        ctx.save();
        ctx.setTransform(ax / sw, ay / sw, bx / sh, by / sh, ox, oy);
        try { ctx.drawImage(tex, sx, sy, sw, sh, 0, 0, sw, sh); } catch { /* ignore */ }
        const sh2 = 1 - t.f.shade;
        if (sh2 > 0.01) {
          ctx.fillStyle = 'rgba(0,0,0,' + (sh2 * 0.55) + ')';
          ctx.fillRect(0, 0, sw, sh);
        }
        ctx.restore();
      }
    }

    tris.sort((a, b) => a.depth - b.depth);

    paint(tris);
  }

  window.TPCLSkin3D = { render };
})();
