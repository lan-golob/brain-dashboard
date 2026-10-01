#!/usr/bin/env python3
"""Render the app icon (an ember particle orb) to a 1024px PNG. Stdlib only."""
import math
import random
import struct
import sys
import zlib

S = 1024
CX = CY = S / 2
R = 300                      # orb radius
INSET, CORNER = 100, 185     # macOS icon grid: rounded square
random.seed(7)

# accumulated light per pixel (linear), plus background
light = [0.0] * (S * S)


def add_dot(x, y, amount, rad=1.6):
    r = int(rad * 3) + 1
    xi, yi = int(x), int(y)
    for dy in range(-r, r + 1):
        py = yi + dy
        if not 0 <= py < S:
            continue
        for dx in range(-r, r + 1):
            px = xi + dx
            if 0 <= px < S:
                d2 = (px - x) ** 2 + (py - y) ** 2
                light[py * S + px] += amount * math.exp(-d2 / (2 * rad * rad))


def project(v, tilt=0.35, spin=0.6):
    x, y, z = v
    x, z = x * math.cos(spin) + z * math.sin(spin), -x * math.sin(spin) + z * math.cos(spin)
    y, z = y * math.cos(tilt) - z * math.sin(tilt), y * math.sin(tilt) + z * math.cos(tilt)
    return CX + x * R, CY - y * R, z


# shell particles: bright at the rim, dimmer on the back
N = 9000
g = math.pi * (3 - math.sqrt(5))
for i in range(N):
    y = 1 - (i / (N - 1)) * 2
    rr = math.sqrt(1 - y * y)
    t = g * i + random.uniform(-0.6, 0.6)
    y = max(-1.0, min(1.0, y + random.uniform(-0.004, 0.004)))
    rr = math.sqrt(1 - y * y)
    v = (math.cos(t) * rr, y, math.sin(t) * rr)
    x, yy, z = project(v)
    rim = 1 - abs(z)
    a = (0.035 + 1.5 * rim ** 3.2) * (0.5 if z < 0 else 1.0) * random.uniform(0.4, 1.0)
    add_dot(x, yy, a * 0.9, rad=random.uniform(1.0, 1.8))

# ribbons: wide bands of particles hugging the sphere, curling off at the tips
for k, (tilt, spin, phase) in enumerate([(0.9, 0.3, 0.0), (-0.5, 1.9, 1.7), (0.2, -1.0, 3.3)]):
    for j in range(5200):
        u = random.random()
        v = random.uniform(-1, 1)
        phi = u * 2.4 + phase
        taper = math.sin(math.pi * u) ** 0.7
        theta = math.sin(u * 3 + k) * 0.3 + v * 0.22 * taper
        lift = 1.03 + (u ** 6) * 0.32 + max(math.sin(u * 6 + k), 0) * (v * 0.5 + 0.5) * 0.12
        p = (math.cos(theta) * math.cos(phi) * lift, math.sin(theta) * lift, math.cos(theta) * math.sin(phi) * lift)
        x, yy, z = project(p, tilt, spin)
        edge = abs(v) ** 4
        add_dot(x, yy, 0.55 * taper * (0.25 + 0.9 * edge) * random.uniform(0.5, 1), rad=random.uniform(0.9, 1.5))

# dust drifting off the surface
for _ in range(500):
    a, b = random.uniform(0, math.tau), random.uniform(-1, 1)
    rr = 1.05 + random.random() ** 2 * 0.45
    p = (math.cos(a) * math.sqrt(1 - b * b) * rr, b * rr, math.sin(a) * math.sqrt(1 - b * b) * rr)
    x, yy, _z = project(p)
    add_dot(x, yy, (1.5 - rr) * 0.8, rad=1.6)


def in_rounded_square(x, y):
    lo, hi = INSET, S - INSET
    if not (lo <= x < hi and lo <= y < hi):
        return 0.0
    cx = min(max(x, lo + CORNER), hi - CORNER)
    cy = min(max(y, lo + CORNER), hi - CORNER)
    d = math.hypot(x - cx, y - cy)
    return max(0.0, min(1.0, CORNER - d + 0.5))


rows = []
for y in range(S):
    row = bytearray([0])
    for x in range(S):
        mask = in_rounded_square(x + 0.5, y + 0.5)
        if mask == 0:
            row += b"\0\0\0\0"
            continue
        d = math.hypot(x - CX, y - CY)
        # soft glow and inner haze around the orb
        glow = 0.2 * math.exp(-abs(d - R) / 34) + 0.06 * min(1.0, d / R) ** 4 * math.exp(-max(d - R, 0) / 25)
        L = light[y * S + x] * 0.55 + glow
        # tone map: orange, toward amber/white at the brightest points
        r = 1 - math.exp(-L * 2.2)
        gch = 1 - math.exp(-L * 0.95)
        b = 1 - math.exp(-L * 0.35)
        bg = 0.012 * math.exp(-d / 420)
        row += bytes((int(min(1, r + bg) * 255), int(min(1, gch + bg * 0.4) * 255), int(min(1, b) * 255), int(mask * 255)))
    rows.append(bytes(row))


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0)) \
    + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
open(sys.argv[1] if len(sys.argv) > 1 else "icon.png", "wb").write(png)
