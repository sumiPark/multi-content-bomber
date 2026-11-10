// 공통 엔진: production.json의 장면 · 카메라 · 배우를 시각 t에 대해 계산한다(스타일과 무관).
// 결정적이다: Math.random · Date.now를 쓰지 않고, 이전 프레임 상태를 들고 다니지 않는다(어느 프레임이든 혼자 그릴 수 있다).
// 좌표: production.size(예: 1080×1920)가 한 쪽 "세계"다. 계약의 0~1 좌표에 폭 · 높이를 곱해 세계 px로 바꾼다.
import { clamp, lerp, ss, eo, eio } from '/core/lib.js';
import { seedOf } from './geom.js';

export const EASE = {
  linear: u => clamp(u),
  in: u => { u = clamp(u); return u * u; },
  out: u => eo(u),
  inout: u => eio(u),
};

// 동작 표. move: 이동(from → to)이 일어나는 구간(동작 시작 기준 초). 'scene'이면 장면 끝까지.
// dur: 한 번 하고 끝나는 동작의 길이(시트 키포즈 · 위상 계산용), loop: 반복 동작
export const ACTIONS = {
  idle: { loop: true, move: 'scene', ease: 'inout', desc: '가만히 숨쉬기(제자리)' },
  walk: { loop: true, move: 'scene', ease: 'linear', desc: '걷기: 발을 번갈아 들고 몸이 오르내림. to가 있으면 장면 끝까지 걸어서 이동' },
  hop: { dur: 1.1, move: [0.2, 0.7], ease: 'inout', arc: 0.6, desc: '폴짝 한 번(웅크림 → 뜀 → 착지 눌림 → 편히 앉음)' },
  wave: { loop: true, desc: '한 손 흔들기(두 장 교대)' },
  point: { loop: true, desc: '가리키기: look 대상(배우 · 좌표) 쪽으로 팔을 뻗음' },
  nod: { loop: true, desc: '고개 끄덕임(몸을 숙였다 폄, 0.8초마다)' },
  bow: { dur: 0.36, stagger: 0.42, desc: '차례로 인사: 같은 장면의 bow 배우가 왼쪽부터 0.42초 간격으로 한 번씩 숙임' },
  shake: { loop: true, desc: '아니라고 몸을 좌우로 흔듦' },
  jump: { dur: 0.9, move: [0, 0.45], ease: 'linear', arc: 1.0, desc: '크게 뛰기(웅크림 → 팔 들고 뜀 → 착지). to가 있으면 0.45초 동안 포물선으로 날아가 내려앉음' },
  hug: { loop: true, desc: '안기: look 대상을 두 팔로 감싸고 좌우로 흔듦' },
  push: { loop: true, move: 'scene', ease: 'linear', desc: '밀기: 몸을 앞으로 기울이고 두 팔을 앞으로 뻗어 버팀' },
  lift: { loop: true, desc: '들어 올리기: 두 팔을 머리 위로, 힘주어 떨림' },
  shrink: { dur: 0.6, desc: '움츠러듦: 0.6초 동안 작아지며 스스로 껴안음' },
  cheer: { loop: true, desc: '환호: 두 팔 번갈아 번쩍 + 작은 콩콩 뛰기' },
  fall: { dur: 1.4, move: [0, 1.15], ease: 'in', desc: '떨어지기: 1.15초 동안 낙하 후 찌그러졌다 튀며 착지' },
  float: { loop: true, move: [0.2, 1.6], ease: 'inout', desc: '떠오르기: 팔을 번갈아 들고 흔들리며 1.4초 동안 이동' },
  pulled: { move: [0.55, 1.5], ease: 'inout', desc: '붙잡혀 끌려 내려옴: 0.5초에 look 대상과 손이 잡히고 0.55~1.5초에 이동, 착지 후 손을 잡고 있음' },
  pull: { loop: true, desc: '손 뻗어 붙잡아 당기기: look 대상의 손을 0.5초에 잡고 이후 계속 잡고 있음' },
  link: { dur: 0.55, desc: '양옆 배우와 손 잡기: 같은 장면에서 link 하는 이웃(왼쪽 · 오른쪽)에게 0.2~0.55초에 손을 뻗어 잡음' },
  sit: { dur: 0.4, desc: '편히 앉기(살짝 눌리고 팔을 내림)' },
};

// 전환 길이(초). match는 이미지 섞기가 아니라 카메라가 앞 장면 끝에서 이어서 미끄러지는 시간
export const TRANS_DUR = { cut: 0, fade: 0.4, wipe: 0.5, 'page-turn': 0.66, match: 0.45 };

export function makeTimeline(prod, rigs, specs) {
  const W = prod.size.w, H = prod.size.h, kw = W / 1080;
  const scenes = prod.scenes;
  const castMap = new Map(prod.cast.map(c => [c.id, c]));
  const actInfo = (name, rig) => (rig && rig.ACTIONS && rig.ACTIONS[name]) || ACTIONS[name] || ACTIONS.idle;

  // 장면을 넘어 이어지는 동작 · 표정: 직전 장면에서 같은 배우가 같은 동작을 하던 중이면(이번 장면에 이동 · 등장이 없을 때) 동작 시간이 이어진다
  scenes.forEach((s, i) => {
    const prev = i > 0 ? scenes[i - 1] : null;
    for (const a of s.actors) {
      const p = prev && prev.actors.find(b => b.cast === a.cast);
      const cont = p && p.action === a.action && a.enter_at == null && !a.to && !p.to && p.exit_at == null;
      a._actStart = cont ? p._actStart : s.start + (a.enter_at ?? 0);
      const pExpr = p ? (p.expr_to && p.expr_at != null ? p.expr_to : p.expr) : null;
      const pExprStart = p ? (p.expr_to && p.expr_at != null ? p._exprToStart : p._exprStart) : 0;
      a._exprStart = p && pExpr === a.expr && p.exit_at == null ? pExprStart : s.start + (a.enter_at ?? 0);
      a._exprToStart = a.expr_at != null ? s.start + a.expr_at : null;
    }
  });

  function sceneIndex(t) {
    for (let i = 0; i < scenes.length; i++) if (t < scenes[i].end) return Math.max(0, i);
    return scenes.length - 1;
  }

  const camKey = c => ({ x: c.x, y: c.y, zoom: c.zoom, rot: c.rot ?? 0 });
  const mixCam = (a, b, u) => ({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), zoom: Math.exp(lerp(Math.log(a.zoom), Math.log(b.zoom), u)), rot: lerp(a.rot, b.rot, u) });
  function camPath(s, local) {
    const u = (EASE[s.camera.ease] || EASE.inout)(local / Math.max(1e-3, s.end - s.start));
    return mixCam(camKey(s.camera.from), camKey(s.camera.to), u);
  }
  // 카메라: 장면 안에서 from → to(ease). match 전환이면 시작 0.45초 동안 앞 장면 끝 카메라에서 이어서 미끄러진다
  function camAt(i, t) {
    const s = scenes[i], local = t - s.start, c = camPath(s, local);
    if (i > 0 && s.transition_in === 'match' && local < TRANS_DUR.match) {
      const p = scenes[i - 1], pc = camPath(p, p.end - p.start);
      return mixCam(pc, c, ss(local / TRANS_DUR.match));
    }
    return c;
  }

  // 배우 상태(세계 px). q = 그림 시각(12fps로 계단), ground = 배경이 알려 주는 바닥 높이 함수
  function poses(s, q) {
    const lq = q - s.start, out = [];
    // 같은 동작 배우들의 순번(왼쪽부터) — 차례로 하는 동작(bow 등)에 쓴다
    const rankOf = new Map();
    const byAct = {};
    for (const a of s.actors) (byAct[a.action] ||= []).push(a);
    for (const k in byAct) byAct[k].slice().sort((a, b) => a.from.x - b.from.x).forEach((a, i) => rankOf.set(a, i));
    for (const a of s.actors) {
      if (a.enter_at != null && lq < a.enter_at) continue;
      if (a.exit_at != null && lq >= a.exit_at) continue;
      const cast = castMap.get(a.cast); if (!cast) continue;
      const spec = specs.get(cast.character); if (!spec) continue;
      const rig = rigs.get(spec.id), info = actInfo(a.action, rig);
      const at = q - a._actStart;
      const fx = a.from.x * W, fy = a.from.y * H;
      let x = fx, y = fy, scale = a.from.scale, moveU = null, facing = a.from.facing || 'front';
      if (a.to) {
        const w = !info.move || info.move === 'scene' ? [0, Math.max(0.05, s.end - a._actStart)] : info.move;
        const u = clamp((at - w[0]) / Math.max(1e-3, w[1] - w[0]));
        const e = (EASE[info.ease] || EASE.inout)(u);
        const tx = a.to.x * W, ty = a.to.y * H;
        x = lerp(fx, tx, e); y = lerp(fy, ty, e); scale = lerp(a.from.scale, a.to.scale, e);
        if (info.arc) {
          const hgt = spec.body.height * kw * scale, d = Math.hypot(tx - fx, ty - fy);
          y -= Math.sin(Math.PI * u) * Math.min(Math.max(info.arc * 0.5 * hgt, 0.3 * d), 1.2 * hgt + 0.3 * d);
        }
        moveU = u;
        if (u >= 1) facing = a.to.facing || facing;
      }
      // 등장 · 퇴장: 이동 없이 장면 중간에 나타나면 0.15초 동안 커지며, 퇴장 0.2초 전부터 작아진다
      let pop = 1;
      if (a.enter_at != null && !a.to) pop = Math.min(pop, clamp((lq - a.enter_at) / 0.15));
      if (a.enter_at != null && a.to && moveU != null) pop = Math.min(pop, lerp(0.45, 1, eo(clamp(moveU * 1.4))));
      if (a.exit_at != null) pop = Math.min(pop, clamp((a.exit_at - lq) / 0.2));
      const toActive = a.expr_to && a.expr_at != null && lq >= a.expr_at;
      const expr = toActive ? a.expr_to : a.expr;
      const exprAge = q - (toActive ? a._exprToStart : a._exprStart);
      const height = spec.body.height * kw * scale * Math.max(0.02, pop);
      out.push({
        id: a.cast, role: cast.role, character: spec.id, spec, rig, actor: a,
        x, y, scale: scale * Math.max(0.02, pop), height, facing, flip: facing === 'left', view: facing === 'front' ? 'front' : 'q',
        expr, exprAge, action: a.action, at, info, moveU, moving: moveU != null && moveU > 0 && moveU < 1,
        rank: rankOf.get(a) ?? 0, seed: seedOf(a.cast), q, local: lq, sceneDur: s.end - s.start,
        look: null, lookAt: null, partners: { target: null, left: null, right: null },
      });
    }
    // 시선 · 상대: look이 배우 id면 그 배우의 얼굴 쪽, 좌표면 그 점
    const byId = new Map(out.map(p => [p.id, p]));
    for (const p of out) {
      const L = p.actor.look;
      let tgt = null;
      if (typeof L === 'string') { const o = byId.get(L); if (o) { tgt = [o.x, o.y - o.height * 0.6]; p.partners.target = brief(o); } }
      else if (L && typeof L === 'object') tgt = [L.x * W, L.y * H];
      if (tgt) {
        p.lookAt = tgt;
        const hx = p.x, hy = p.y - p.height * 0.6, dx = tgt[0] - hx, dy = tgt[1] - hy, d = Math.hypot(dx, dy) || 1;
        p.look = [dx / d, dy / d];
      }
    }
    // link: 양옆 이웃
    const linkers = out.filter(p => p.action === 'link').sort((a, b) => a.x - b.x);
    linkers.forEach((p, i) => { p.partners.left = i > 0 ? brief(linkers[i - 1]) : null; p.partners.right = i < linkers.length - 1 ? brief(linkers[i + 1]) : null; });
    // 그리는 순서: 발이 위쪽(먼) 배우부터
    out.sort((a, b) => a.y - b.y);
    return out;
  }
  function brief(o) {
    const hwK = o.rig && typeof o.rig.halfWidth === 'function' ? o.rig.halfWidth(o.spec) : 0.4;
    return { id: o.id, x: o.x, y: o.y, height: o.height, hw: o.height * hwK, action: o.action, at: o.at, moveU: o.moveU };
  }

  return { W, H, kw, scenes, sceneIndex, camAt, poses };
}
