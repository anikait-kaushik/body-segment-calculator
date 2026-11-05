// Run with: node --test
// Loads the engine out of index.html, so the tests exercise the exact code users run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const match = html.match(/<script id="engine">([\s\S]*?)<\/script>/);
assert.ok(match, 'engine script block not found in index.html');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(match[1], sandbox);
const { BSP } = vm.runInContext('({ BSP: globalThis.BSP })', sandbox);

const close = (actual, expected, tol, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label} expected ${expected} +/- ${tol}, got ${actual}`);
const row = (res, id) => res.rows.find((r) => r.id === id);
const seg = (id) => BSP.SEGMENTS.find((s) => s.id === id);

test('every built-in validation check passes', () => {
  const failing = BSP.validate().filter((c) => c.status === 'fail');
  assert.equal(failing.length, 0, JSON.stringify(failing, null, 2));
});

test('Example 4.1: whole-body density', () => {
  close(BSP.compute({ heightCm: 178, massKg: 77.3 }).bodyDensityKgPerL, 1.066, 0.0006);
});

test('Example 4.6: leg inertia for an 80 kg subject with a 0.435 m leg', () => {
  const leg = row(BSP.compute({ heightCm: 175, massKg: 80, overrides: { leg: 43.5 } }), 'leg');
  close(leg.massKg, 3.72, 1e-9);
  close(leg.iCg, 0.064, 0.0006);
  close(leg.iProx, 0.196, 0.0006);
  close(leg.iDist, 0.291, 0.0006);
});

test('Example 4.7: HAT inertia with a 0.295 m segment', () => {
  const hat = row(BSP.compute({ heightCm: 175, massKg: 80, overrides: { hatRib: 29.5 } }), 'hatRib');
  close(hat.massKg, 54.24, 1e-9);
  close(hat.iProx, 10.01, 0.006);
  close(hat.iCg, 3.85, 0.006);
});

test('Problem 1: forearm of 24 cm', () => {
  const fa = row(BSP.compute({ heightCm: 175, massKg: 70, overrides: { forearm: 24 } }), 'forearm');
  close(fa.comProxCm, 10.32, 0.005);
  close(fa.kProxCm, 12.62, 0.005);
});

test('Figure 4.1 lengths at H = 200 cm', () => {
  const r = BSP.compute({ heightCm: 200, massKg: 70 });
  const expected = {
    hand: 21.6, forearm: 29.2, upperArm: 37.2, thigh: 49, leg: 49.2, foot: 30.4,
    // Ratios defined over a shorter span than the name suggests
    forearmHand: 29.2, footLeg: 49.2,
    totalArm: 66.4, totalLeg: 98.2,
    // Starred rows share the trochanter to glenohumeral length
    thorax: 57.6, abdomen: 57.6, pelvis: 57.6, trunk: 57.6, hat: 57.6, trunkHeadNeck: 57.6
  };
  for (const [id, cm] of Object.entries(expected)) close(row(r, id).lengthCm, cm, 1e-9, id);
});

test('whole body closes to 100% of mass', () => {
  const r = BSP.compute({ heightCm: 175, massKg: 70 });
  const limb = ['hand', 'forearm', 'upperArm', 'foot', 'leg', 'thigh'].reduce((a, id) => a + row(r, id).massKg, 0);
  close(2 * limb + row(r, 'headNeck').massKg + row(r, 'trunk').massKg, 70, 1e-9);
});

test('parallel-axis theorem holds for every printed radius of gyration', () => {
  for (const s of BSP.SEGMENTS) {
    if (s.kc === null) continue;
    if (s.kp !== null) close(s.kp, Math.hypot(s.kc, s.cp), 0.0085, `${s.id} prox`);
    if (s.kd !== null && s.cd !== null) close(s.kd, Math.hypot(s.kc, s.cd), 0.0085, `${s.id} dist`);
  }
});

test('head and neck k_prox uses the corrected 1.116, not the printed 0.116', () => {
  assert.equal(seg('headNeck').kp, 1.116);
  assert.equal(seg('headNeck').kpPrinted, 0.116);
});

test('both HAT rows locate the same centre of mass and inertia', () => {
  const r = BSP.compute({ heightCm: 175, massKg: 70 });
  close(row(r, 'hat').comProxCm, row(r, 'hatRib').comProxCm, 1e-9);
  const ratio = row(r, 'hat').iCg / row(r, 'hatRib').iCg;
  close(ratio, 1, 0.005);
});

test('measured lengths propagate to composite segments', () => {
  const r = BSP.compute({ heightCm: 175, massKg: 70, overrides: { thigh: 40, leg: 38 } });
  assert.equal(row(r, 'thigh').lengthCm, 40);
  assert.equal(row(r, 'totalLeg').lengthCm, 78);
  assert.equal(row(r, 'footLeg').lengthCm, 38);
  assert.equal(row(r, 'totalLeg').measured, true);
});

test('a measured trunk length also moves the HAT mid-rib length', () => {
  const r = BSP.compute({ heightCm: 175, massKg: 70, overrides: { trunk: 50 } });
  close(row(r, 'hatRib').lengthCm, 50 * 0.626 / 1.142, 1e-9);
});

test('missing table values stay null instead of becoming zero or NaN', () => {
  const r = BSP.compute({ heightCm: 175, massKg: 70 });
  assert.equal(row(r, 'shoulder').massKg, null);
  assert.equal(row(r, 'shoulder').volumeL, null);
  assert.equal(row(r, 'shoulder').iCg, null);
  assert.equal(row(r, 'headNeck').comDistCm, null);
  assert.equal(row(r, 'abdomen').volumeL, null);
  for (const rw of r.rows) for (const v of Object.values(rw)) assert.ok(!Number.isNaN(v));
});

test('invalid subject input is rejected', () => {
  for (const bad of [{ heightCm: 0, massKg: 70 }, { heightCm: 175, massKg: -1 }, { heightCm: NaN, massKg: 70 }]) {
    assert.throws(() => BSP.compute(bad), /positive/);
  }
});

/* ── de Leva (1996), Table 4 ── */
const dl = (sex) => BSP.segmentsFor(sex === 'M' ? 'deLevaM' : 'deLevaF');
const dlSeg = (sex, id) => dl(sex).find((s) => s.id === id);

test('de Leva table has all 21 printed rows for both sexes', () => {
  assert.equal(dl('M').length, 21);
  assert.equal(dl('F').length, 21);
});

test('de Leva table is locked: column totals match an independent transcription', () => {
  const totals = {
    F: { len: 6038.7, mass: 237.14, cm: 979.08, sag: 754.0, tr: 674.9, lg: 499.0 },
    M: { len: 6222.9, mass: 240.59, cm: 1035.99, sag: 807.1, tr: 701.6, lg: 545.2 }
  };
  const keys = { len: 'lenMm', mass: 'mass', cm: 'cm', sag: 'rs', tr: 'rt', lg: 'rl' };
  for (const sex of ['F', 'M']) {
    for (const [name, key] of Object.entries(keys)) {
      const sum = dl(sex).reduce((a, s) => a + s[key], 0);
      close(sum, totals[sex][name], 1e-6, `${sex} ${name}`);
    }
  }
});

test('at the reference stature, computed lengths equal the printed lengths', () => {
  for (const [model, sex, h] of [['deLevaM', 'M', 174.1], ['deLevaF', 'F', 173.5]]) {
    const r = BSP.compute({ model, heightCm: h, massKg: 70 });
    for (const s of dl(sex)) close(row(r, s.id).lengthCm * 10, s.lenMm, 1e-9, s.id);
  }
});

test('de Leva spot values: printed rows, read from the paper', () => {
  const t = dlSeg('M', 'thigh');
  assert.deepEqual([t.lenMm, t.mass, t.cm, t.rs, t.rt, t.rl], [422.2, 14.16, 40.95, 32.9, 32.9, 14.9]);
  const f = dlSeg('F', 'thigh');
  assert.deepEqual([f.lenMm, f.mass, f.cm, f.rs, f.rt, f.rl], [368.5, 14.78, 36.12, 36.9, 36.4, 16.2]);
  const s = dlSeg('M', 'shankAjc');
  assert.deepEqual([s.origin, s.other, s.lenMm, s.cm], ['KJC', 'AJC', 440.3, 43.95]);
  assert.equal(dlSeg('M', 'shank').other, 'LMAL');
});

test('de Leva calculation: male thigh by hand', () => {
  const t = row(BSP.compute({ model: 'deLevaM', heightCm: 174.1, massKg: 73 }), 'thigh');
  close(t.massKg, 10.3368, 1e-9);
  close(t.comFromOriginCm, 17.28909, 1e-9);
  close(t.comFromOriginCm + t.comFromOtherCm, t.lengthCm, 1e-9);
  close(t.iTrans, 10.3368 * (0.329 * 0.4222) ** 2, 1e-9);
  close(t.iLong, 10.3368 * (0.149 * 0.4222) ** 2, 1e-9);
});

test('male and female tables give different results', () => {
  const m = row(BSP.compute({ model: 'deLevaM', heightCm: 170, massKg: 65 }), 'thigh');
  const f = row(BSP.compute({ model: 'deLevaF', heightCm: 170, massKg: 65 }), 'thigh');
  assert.notEqual(m.massKg, f.massKg);
  assert.notEqual(m.lengthCm, f.lengthCm);
});

test('a measured length applies only to its own de Leva row', () => {
  const r = BSP.compute({ model: 'deLevaF', heightCm: 170, massKg: 60, overrides: { thigh: 40 } });
  assert.equal(row(r, 'thigh').lengthCm, 40);
  assert.equal(row(r, 'thigh').measured, true);
  assert.equal(row(r, 'shank').measured, false);
});

test('Winter stays the default model and unknown models are rejected', () => {
  assert.equal(BSP.compute({ heightCm: 175, massKg: 70 }).modelId, 'winter');
  assert.throws(() => BSP.compute({ model: 'nope', heightCm: 175, massKg: 70 }), /Unknown model/);
});
