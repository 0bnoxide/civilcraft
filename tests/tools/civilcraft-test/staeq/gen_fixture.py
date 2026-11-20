"""Synthetic station-equation fixture (Slice 0 baseline, reused for the Slice 1 tests): independent geometry (numeric clothoid integration), LandXML 1.2, US survey feet.
Writes fixture XML + expected.json. Variant B = same numbers labelled international foot + EPSG:2256."""
import math, json, sys, os
OUT = sys.argv[1]
def rot(v, a): return (v[0]*math.cos(a)-v[1]*math.sin(a), v[0]*math.sin(a)+v[1]*math.cos(a))
def add(p, v, s=1.0): return (p[0]+v[0]*s, p[1]+v[1]*s)
def u(a): return (math.cos(a), math.sin(a))
def clothoid_xy(l, R, Ls, n=20000):
    # x=∫cos(t^2/(2RLs)), y=∫sin(...), Simpson
    A2 = 2*R*Ls; h = l/n; sx = sy = 0.0
    for i in range(n+1):
        t = i*h; w = 1 if i in (0, n) else (4 if i % 2 else 2)
        sx += w*math.cos(t*t/A2); sy += w*math.sin(t*t/A2)
    return sx*h/3, sy*h/3

E0, N0 = 2000000.0, 800000.0
P0 = (E0, N0); d0 = math.radians(30)
PI1 = add(P0, u(d0), 1200.0); D1 = math.radians(40); R1 = 1000.0; Ls = 200.0   # left (ccw)
d1 = d0 + D1
PI2 = add(PI1, u(d1), 1400.0); D2 = math.radians(25); R2 = 800.0              # right (cw)
d2 = d1 - D2
P3 = add(PI2, u(d2), 1000.0)
STA0 = 10000.0

ths = Ls/(2*R1); Xs, Ys = clothoid_xy(Ls, R1, Ls)
p = Ys - R1*(1-math.cos(ths)); k = Xs - R1*math.sin(ths)
Ts1 = (R1+p)*math.tan(D1/2) + k
TS1 = add(PI1, u(d0), -Ts1); ST1 = add(PI1, u(d1), Ts1)
nL0 = u(d0+math.pi/2)                       # left normal on back tangent
SC1 = add(add(TS1, u(d0), Xs), nL0, Ys)
nR1 = u(d1-math.pi/2)                       # mirrored for the out spiral (from ST back toward CS)
CS1 = add(add(ST1, u(d1), -Xs), u(d1+math.pi/2), Ys)
C1 = add(add(TS1, u(d0), k), nL0, R1+p)
Lc1 = R1*(D1-2*ths)
tanLong = Xs - Ys/math.tan(ths); tanShort = Ys/math.sin(ths)
SPI_in = add(TS1, u(d0), tanLong); SPI_out = add(ST1, u(d1), -tanLong)
Tc1 = R1*math.tan((D1-2*ths)/2); CPI1 = add(SC1, u(d0+ths), Tc1)
T2 = R2*math.tan(D2/2); PC2 = add(PI2, u(d1), -T2); PT2 = add(PI2, u(d2), T2)
C2 = add(PC2, u(d1-math.pi/2), R2); Lc2 = R2*D2
L1 = 1200-Ts1; L2 = 1400-Ts1-T2; L3 = 1000-T2
els = [('line', L1), ('spin', Ls), ('arc1', Lc1), ('spout', Ls), ('line2', L2), ('arc2', Lc2), ('line3', L3)]
sta = STA0; starts = {}
for nm, ln in els: starts[nm] = sta; sta += ln
LEN = sta - STA0; STA_END = sta
EQ_INTERNAL, EQ_AHEAD = 12000.0, 12100.0    # back 120+00 = ahead 121+00 (+100.00 ft)
assert starts['line2'] < EQ_INTERNAL < starts['arc2']

def point_at(s):
    """internal station -> (x, y, dir)"""
    if s <= starts['spin']: d = s-STA0; return (*add(P0, u(d0), d), d0)
    if s <= starts['arc1']:
        l = s-starts['spin']; x, y = clothoid_xy(l, R1, Ls, 4000)
        q = add(add(TS1, u(d0), x), nL0, y); return (*q, d0 + l*l/(2*R1*Ls))
    if s <= starts['spout']:
        l = s-starts['arc1']; a0 = math.atan2(SC1[1]-C1[1], SC1[0]-C1[0]) + l/R1
        return (C1[0]+R1*math.cos(a0), C1[1]+R1*math.sin(a0), a0+math.pi/2)
    if s <= starts['line2']:
        l = STA0 + 0 + (starts['line2'] - s)   # distance back from ST
        l = starts['line2'] - s; x, y = clothoid_xy(l, R1, Ls, 4000)
        q = add(add(ST1, u(d1), -x), u(d1+math.pi/2), y); return (*q, d1 - l*l/(2*R1*Ls))
    if s <= starts['arc2']: d = s-starts['line2']; return (*add(ST1, u(d1), d), d1)
    if s <= starts['line3']:
        l = s-starts['arc2']; a0 = math.atan2(PC2[1]-C2[1], PC2[0]-C2[0]) - l/R2
        return (C2[0]+R2*math.cos(a0), C2[1]+R2*math.sin(a0), a0-math.pi/2)
    d = s-starts['line3']; return (*add(PT2, u(d2), d), d2)

def disp(s): return s if s < EQ_INTERNAL else s - EQ_INTERNAL + EQ_AHEAD
def fmt(s): b = int(s//100); return f"{b}+{s-b*100:05.2f}"

# surfaces: EG plane over the corridor; FG pad plane near ST1
egz = lambda x, y: 3000 + 0.004*(x-E0) + 0.002*(y-N0)
xs = [P0[0], P3[0], PI1[0], PI2[0]]; ys = [P0[1], P3[1], PI1[1], PI2[1]]
bx0, bx1, by0, by1 = min(xs)-300, max(xs)+300, min(ys)-300, max(ys)+300
def grid(x0, x1, y0, y1, nx, ny, zf):
    pts = [(x0+(x1-x0)*i/(nx-1), y0+(y1-y0)*j/(ny-1)) for j in range(ny) for i in range(nx)]
    pts = [(x, y, zf(x, y)) for x, y in pts]; faces = []
    for j in range(ny-1):
        for i in range(nx-1):
            a = j*nx+i; b = a+1; c = a+nx; d = c+1
            faces += [(a, b, d), (a, d, c)]
    return pts, faces
eg_pts, eg_faces = grid(bx0, bx1, by0, by1, 9, 9, egz)
fgc = add(ST1, u(d1+math.pi/2), 150)
fgz = lambda x, y: 3025 + 0.01*(x-fgc[0]) - 0.005*(y-fgc[1])
fg_pts, fg_faces = grid(fgc[0]-100, fgc[0]+100, fgc[1]-100, fgc[1]+100, 3, 3, fgz)

pvis = [(STA0, 3015.0, 0), (11000.0, 3035.0, 400.0), (12500.0, 3020.0, 500.0), (STA_END, 3032.0, 0)]
pvis_alt = [(STA0, 3012.0, 0), (11900.0, 3022.0, 300.0), (STA_END, 3018.0, 0)]
egprof = [(s, egz(*point_at(s)[:2])) for s in [STA0 + i*100 for i in range(int(LEN//100)+1)] + [STA_END]]

def prof_z(pv, s):
    for i in range(1, len(pv)-1):
        st, z, L = pv[i]
        if L and st-L/2 <= s <= st+L/2:
            g1 = (z-pv[i-1][1])/(st-pv[i-1][0]); g2 = (pv[i+1][1]-z)/(pv[i+1][0]-st); x = s-(st-L/2)
            return z - g1*L/2 + g1*x + (g2-g1)*x*x/(2*L)
    for i in range(len(pv)-1):
        if s <= pv[i+1][0]: return pv[i][1] + (pv[i+1][1]-pv[i][1])*(s-pv[i][0])/(pv[i+1][0]-pv[i][0])
grades = [(pvis[i+1][1]-pvis[i][1])/(pvis[i+1][0]-pvis[i][0]) for i in range(len(pvis)-1)]

pts = []
import random; rnd = random.Random(20261120)
for i in range(12):
    x = rnd.uniform(bx0+50, bx1-50); y = rnd.uniform(by0+50, by1-50)
    pts.append((f"{1001+i}", x, y, egz(x, y), ["TOPO", "EP", "IP"][i % 3]))

samples = []
for s, off in [(10400, 25), (10800, -25), (11000, 25), (11300, -25), (11700, 25), (12200, -25), (12600, 25), (13500, -25)]:
    x, y, dr = point_at(s); n = u(dr-math.pi/2)   # right normal
    samples.append({'sta_internal': s, 'off': off, 'x': x+n[0]*off, 'y': y+n[1]*off, 'cl_x': x, 'cl_y': y, 'sta_display': disp(s), 'label': fmt(disp(s))})

N = lambda v: f"{v:.6f}"
NE = lambda q: f"{N(q[1])} {N(q[0])}"
def write(path, unit_attr, crs):
    L = ['<?xml version="1.0" encoding="UTF-8"?>',
         '<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2" date="2026-11-20" time="00:00:00">',
         '  <Units>', f'    <Imperial areaUnit="squareFoot" linearUnit="{unit_attr}" volumeUnit="cubicYard" temperatureUnit="fahrenheit" pressureUnit="inHG" diameterUnit="inch" angularUnit="decimal degrees" directionUnit="decimal degrees"/>', '  </Units>']
    if crs: L.append(f'  <CoordinateSystem name="NAD83 / Montana (ft)" epsgCode="{crs}"/>')
    L += ['  <Project name="S0-Synthetic-Site"/>', '  <Application name="slice0-gen" version="1"/>', '  <CgPoints>']
    for n, x, y, z, c in pts: L.append(f'    <CgPoint name="{n}" desc="{c}" code="{c}">{N(y)} {N(x)} {N(z)}</CgPoint>')
    L += ['  </CgPoints>', '  <Alignments name="S0">', f'    <Alignment name="CL-Main" length="{N(LEN)}" staStart="{N(STA0)}">', '      <CoordGeom>']
    L.append(f'        <Line staStart="{N(starts["line"])}" length="{N(L1)}"><Start>{NE(P0)}</Start><End>{NE(TS1)}</End></Line>')
    L.append(f'        <Spiral rot="ccw" spiType="clothoid" length="{N(Ls)}" radiusStart="INF" radiusEnd="{N(R1)}" staStart="{N(starts["spin"])}" theta="{math.degrees(ths):.8f}" totalX="{N(Xs)}" totalY="{N(Ys)}" tanLong="{N(tanLong)}" tanShort="{N(tanShort)}"><Start>{NE(TS1)}</Start><PI>{NE(SPI_in)}</PI><End>{NE(SC1)}</End></Spiral>')
    L.append(f'        <Curve rot="ccw" crvType="arc" radius="{N(R1)}" length="{N(Lc1)}" staStart="{N(starts["arc1"])}"><Start>{NE(SC1)}</Start><Center>{NE(C1)}</Center><End>{NE(CS1)}</End><PI>{NE(CPI1)}</PI></Curve>')
    L.append(f'        <Spiral rot="ccw" spiType="clothoid" length="{N(Ls)}" radiusStart="{N(R1)}" radiusEnd="INF" staStart="{N(starts["spout"])}" theta="{math.degrees(ths):.8f}" totalX="{N(Xs)}" totalY="{N(Ys)}" tanLong="{N(tanLong)}" tanShort="{N(tanShort)}"><Start>{NE(CS1)}</Start><PI>{NE(SPI_out)}</PI><End>{NE(ST1)}</End></Spiral>')
    L.append(f'        <Line staStart="{N(starts["line2"])}" length="{N(L2)}"><Start>{NE(ST1)}</Start><End>{NE(PC2)}</End></Line>')
    L.append(f'        <Curve rot="cw" crvType="arc" radius="{N(R2)}" length="{N(Lc2)}" staStart="{N(starts["arc2"])}"><Start>{NE(PC2)}</Start><Center>{NE(C2)}</Center><End>{NE(PT2)}</End><PI>{NE(PI2)}</PI></Curve>')
    L.append(f'        <Line staStart="{N(starts["line3"])}" length="{N(L3)}"><Start>{NE(PT2)}</Start><End>{NE(P3)}</End></Line>')
    L += ['      </CoordGeom>', f'      <StaEquation staInternal="{N(EQ_INTERNAL)}" staBack="{N(EQ_INTERNAL)}" staAhead="{N(EQ_AHEAD)}" desc="EQ-1"/>',
          '      <Profile name="CL-Main">', '        <ProfSurf name="EG-Survey-2026"><PntList2D>' + ' '.join(f"{N(s)} {N(z)}" for s, z in egprof) + '</PntList2D></ProfSurf>']
    for nm, pv in [('FG Design', pvis), ('FG Alt', pvis_alt)]:
        L.append(f'        <ProfAlign name="{nm}">')
        for s, z, Lv in pv: L.append(f'          <ParaCurve length="{N(Lv)}">{N(s)} {N(z)}</ParaCurve>' if Lv else f'          <PVI>{N(s)} {N(z)}</PVI>')
        L.append('        </ProfAlign>')
    L += ['      </Profile>', '    </Alignment>', '  </Alignments>', '  <Surfaces name="S0">']
    for nm, sp, sf in [('EG-Survey-2026', eg_pts, eg_faces), ('FG-Pad-A', fg_pts, fg_faces)]:
        L += [f'    <Surface name="{nm}">', '      <Definition surfType="TIN">', '        <Pnts>']
        L += [f'          <P id="{i+1}">{N(q[1])} {N(q[0])} {N(q[2])}</P>' for i, q in enumerate(sp)]
        L += ['        </Pnts>', '        <Faces>'] + [f'          <F>{a+1} {b+1} {c+1}</F>' for a, b, c in sf] + ['        </Faces>', '      </Definition>', '    </Surface>']
    L += ['  </Surfaces>']
    m1 = add(ST1, u(d1-math.pi/2), 60); m2 = add(m1, u(d1), 300)
    L += ['  <PipeNetworks name="S0">', '    <PipeNetwork name="STM-1" pipeNetType="storm">', '      <Structs>',
          f'        <Struct name="MH-1" elevRim="{N(egz(*m1))}" elevSump="{N(egz(*m1)-8.5)}"><Center>{NE(m1)}</Center><CircStruct diameter="4"/><Invert elev="{N(egz(*m1)-8)}" flowDir="out" refPipe="P-1"/></Struct>',
          f'        <Struct name="MH-2" elevRim="{N(egz(*m2))}" elevSump="{N(egz(*m2)-10)}"><Center>{NE(m2)}</Center><CircStruct diameter="4"/><Invert elev="{N(egz(*m1)-8-3)}" flowDir="in" refPipe="P-1"/></Struct>',
          '      </Structs>', '      <Pipes>', f'        <Pipe name="P-1" refStart="MH-1" refEnd="MH-2" length="300" slope="0.01"><CircPipe diameter="1.5"/></Pipe>', '      </Pipes>', '    </PipeNetwork>', '  </PipeNetworks>', '</LandXML>']
    open(path, 'w').write('\n'.join(L) + '\n')
write(os.path.join(OUT, 's0-usft.xml'), 'USSurveyFoot', None)
write(os.path.join(OUT, 's0-intlft-epsg2256.xml'), 'foot', 2256)
exp = {'units': 'US survey foot (variant A); international foot + EPSG:2256 (variant B, same numbers)',
  'alignment': {'name': 'CL-Main', 'staStart': STA0, 'length': LEN, 'staEnd_internal': STA_END, 'staEnd_display': disp(STA_END),
    'start_xy': P0, 'end_xy': P3, 'equation': {'internal': EQ_INTERNAL, 'back': EQ_INTERNAL, 'ahead': EQ_AHEAD},
    'joins': {'TS1': TS1, 'SC1': SC1, 'CS1': CS1, 'ST1': ST1, 'PC2': PC2, 'PT2': PT2},
    'join_sta_internal': {'TS1': starts['spin'], 'SC1': starts['arc1'], 'CS1': starts['spout'], 'ST1': starts['line2'], 'PC2': starts['arc2'], 'PT2': starts['line3']},
    'pis': {'PI1': PI1, 'PI2': PI2}, 'R1': R1, 'Ls': Ls, 'R2': R2, 'elements': len(els)},
  'samples': samples,
  'profiles': {'EG': {'name': 'EG-Survey-2026', 'n': len(egprof)}, 'FG Design': {'pvis': pvis, 'grades': grades, 'z_at': {str(s): prof_z(pvis, s) for s in [10500, 11000, 11100, 12300, 12500, 13000]}}, 'FG Alt': {'pvis': pvis_alt}},
  'surfaces': {'EG-Survey-2026': {'pts': len(eg_pts), 'faces': len(eg_faces), 'plane': '3000 + 0.004*(E-2000000) + 0.002*(N-800000)'},
               'FG-Pad-A': {'pts': len(fg_pts), 'faces': len(fg_faces), 'center': fgc}},
  'points': [{'n': n, 'x': x, 'y': y, 'z': z, 'd': c} for n, x, y, z, c in pts],
  'pipes': {'network': 'STM-1', 'structs': ['MH-1', 'MH-2'], 'pipes': ['P-1']}}
json.dump(exp, open(os.path.join(OUT, 'expected.json'), 'w'), indent=1)
print('len', LEN, 'end', STA_END, 'Ts1', Ts1, 'starts', starts)
