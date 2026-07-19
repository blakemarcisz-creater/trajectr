// Estimated carry distance for a batted baseball.
// The R10 doesn't compute distance for baseball, so we fly the ball ourselves:
// numerical integration with aerodynamic drag and Magnus lift (backspin).
// Coefficients follow the published baseball-flight literature (Nathan/Sawicki):
// Cd ≈ 0.35; Cl = 1.5·S below S=0.1, else 0.09 + 0.6·S, where S = rω/v.

const MASS = 0.145;            // kg
const RADIUS = 0.0366;         // m
const AREA = Math.PI * RADIUS * RADIUS;
const RHO = 1.225;             // air density kg/m³
const G = 9.81;
const CD = 0.35;
const CONTACT_HEIGHT = 0.9;    // m, typical bat-contact height
const DT = 0.005;

export function estimateCarryFt(evMph, laDeg, spinRpm) {
  if (evMph == null || laDeg == null) return null;
  const v0 = evMph / 2.23694;
  const la = laDeg * Math.PI / 180;
  const omega = (Math.max(0, spinRpm ?? 0)) * 2 * Math.PI / 60;

  let x = 0, y = CONTACT_HEIGHT;
  let vx = v0 * Math.cos(la), vy = v0 * Math.sin(la);

  for (let t = 0; t < 15 && y > 0; t += DT) {
    const v = Math.hypot(vx, vy);
    if (v < 0.01) break;
    const S = Math.min(0.6, omega * RADIUS / v);
    const cl = S < 0.1 ? 1.5 * S : 0.09 + 0.6 * S;
    const fd = 0.5 * RHO * CD * AREA * v * v;
    const fl = 0.5 * RHO * cl * AREA * v * v;
    const ax = (-fd * vx / v - fl * vy / v) / MASS;
    const ay = (-fd * vy / v + fl * vx / v) / MASS - G;
    vx += ax * DT; vy += ay * DT;
    x += vx * DT; y += vy * DT;
  }
  return x * 3.28084;
}
