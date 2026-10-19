"""Render original mathematical SDF swatches for the research document.

Run: python3 hgc/sdf/render_style_atlas.py
Dependencies: numpy, Pillow. No downloaded artwork or application changes.
These are CPU reference illustrations, not benchmarked GLSL templates.
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


OUT = Path(__file__).resolve().parent / "previews"
W, H = 680, 480
x = np.linspace(-1.35, 1.35, W)
y = np.linspace(0.95, -0.95, H)
X, Y = np.meshgrid(x, y)
DX, DY = x[1] - x[0], y[1] - y[0]
AA = 1.5 * DX
TAU = 2 * np.pi
INK = np.array([0.055, 0.075, 0.12])
PAPER = np.array([0.96, 0.94, 0.88])
TEAL = np.array([0.23, 0.83, 0.73])
ORANGE = np.array([0.98, 0.43, 0.18])


def sdf(px, py):
    """Exact Euclidean distance to a ten-segment star boundary, signed by parity."""
    angles = np.pi / 2 + np.arange(10) * TAU / 10
    radii = np.where(np.arange(10) % 2 == 0, 0.76, 0.39)
    vertices = np.column_stack((np.cos(angles) * radii, np.sin(angles) * radii))
    distance2 = np.full(np.broadcast_shapes(np.shape(px), np.shape(py)), np.inf)
    inside = np.zeros(distance2.shape, dtype=bool)
    for a, b in zip(vertices, np.roll(vertices, -1, axis=0)):
        ex, ey = b - a
        vx, vy = px - a[0], py - a[1]
        t = np.clip((vx * ex + vy * ey) / (ex * ex + ey * ey), 0, 1)
        distance2 = np.minimum(distance2, (vx - t * ex) ** 2 + (vy - t * ey) ** 2)
        if abs(ey) > 1e-12:
            crossing = ((a[1] > py) != (b[1] > py)) & (px < a[0] + ex * (py - a[1]) / ey)
            inside ^= crossing
    return np.sqrt(distance2) * np.where(inside, -1, 1)


def smooth(a, b, v):
    t = np.clip((v - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    return np.asarray(a) * (1 - np.asarray(t)[..., None]) + np.asarray(b) * np.asarray(t)[..., None]


def band(d, level=0, width=0.012):
    return 1 - smooth(width - AA, width + AA, np.abs(d - level))


def contours(d, period=0.11, width=0.006):
    q = (d + period / 2) % period - period / 2
    return band(q, width=width)


def palette(t):
    return 0.5 + 0.5 * np.cos(TAU * (np.asarray(t)[..., None] + np.array([0.02, 0.32, 0.62])))


def hash2(a, b):
    z = np.sin(a * 127.1 + b * 311.7) * 43758.5453
    return z - np.floor(z)


def noise(a, b):
    ix, iy = np.floor(a), np.floor(b)
    fx, fy = smooth(0, 1, a - ix), smooth(0, 1, b - iy)
    lo = hash2(ix, iy) * (1 - fx) + hash2(ix + 1, iy) * fx
    hi = hash2(ix, iy + 1) * (1 - fx) + hash2(ix + 1, iy + 1) * fx
    return lo * (1 - fy) + hi * fy


D = sdf(X, Y)
GY, GX = np.gradient(D, DY, DX)
G = np.maximum(np.hypot(GX, GY), 1e-6)
NX, NY = GX / G, GY / G
FILL = 1 - smooth(-AA, AA, D)
EDGE = band(D)
THETA = np.arctan2(NY, NX)
N = 0.65 * noise(X * 9, Y * 9) + 0.35 * noise(X * 23, Y * 23)


def relief(height):
    hy, hx = np.gradient(height, DY, DX)
    normal = np.stack((-hx, -hy, np.ones_like(hx)), axis=-1)
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    light = np.array([-0.4, 0.6, 0.7])
    light /= np.linalg.norm(light)
    return normal, np.clip(normal @ light, 0, 1)


HEIGHT = 0.20 * (1 - np.exp(np.minimum(D, 0) / 0.10))
RN, LIT = relief(HEIGHT)


def render(style):
    if style == 11:
        return mix([0, 0, 0], [1, 1, 1], np.clip(0.5 + D, 0, 1))
    if style == 12:
        col = mix([0.12, 0.38, 0.71], PAPER, np.clip(1 + D / 0.36, 0, 1))
        return mix(col, ORANGE, np.clip(D / 0.65, 0, 1))
    if style == 14:
        return palette(np.floor((D + 0.45) * 7) / 11)
    if style == 16:
        col = mix(PAPER, [0.64, 0.70, 0.61], contours(D, 0.075, 0.002))
        col = mix(col, INK, contours(D, 0.30, 0.008))
        return mix(col, ORANGE, EDGE)
    if style == 17:
        lines = np.zeros_like(D)
        for level in [0, 0.035, 0.075, 0.14, 0.25, 0.44, 0.75, -0.035, -0.075, -0.14, -0.25]:
            lines = np.maximum(lines, band(D, level, 0.003))
        return mix(mix(PAPER, [0.77, 0.86, 0.94], FILL), INK, lines)
    if style == 18:
        stripe = smooth(-0.16, 0.16, np.sin(TAU * D / 0.15))
        return mix(PAPER, INK, stripe)
    if style == 19:
        return mix(INK, TEAL, (D / 0.16) % 1)
    if style == 20:
        # An original, non-monotonic transfer ramp indexed only by distance.
        stops = np.array([[0.07, 0.10, 0.21], [0.9, 0.45, 0.22], [1, 0.91, 0.54],
                          [0.2, 0.3, 0.42], [0.76, 0.91, 0.89], [0.07, 0.10, 0.21]])
        u = np.clip((D + 0.22) / 0.50, 0, 1)
        return np.stack([np.interp(u, np.linspace(0, 1, len(stops)), stops[:, k]) for k in range(3)], -1)
    if style == 2:
        return mix(PAPER, INK, band(D, width=0.018))
    if style == 3:
        col = mix(INK, TEAL, band(D, -0.035, 0.014))
        return mix(col, ORANGE, band(D, 0.045, 0.014))
    if style == 6:
        return INK + FILL[..., None] * np.exp(-np.abs(D)[..., None] * 13) * TEAL
    if style == 23:
        rings = contours(D, 0.095, 0.007) * np.exp(-3.5 * np.abs(D))
        return mix(INK, TEAL, rings)
    if style == 24:
        angle = np.arctan2(Y, X)
        dash = smooth(-0.15, 0.15, np.cos(30 * angle))
        return mix(PAPER, INK, band(D, width=0.024) * dash)
    if style == 25:
        density = 0.7 * np.exp(-np.abs(D) * 5)
        dots = hash2(np.floor(X * 155), np.floor(Y * 155)) < density
        return mix(PAPER, INK, dots)
    if style == 26:
        bayer = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]])
        ix, iy = np.floor(X * 85).astype(int), np.floor(Y * 85).astype(int)
        threshold = (bayer[iy % 4, ix % 4] + 0.5) / 16
        return mix(PAPER, INK, np.exp(-np.abs(D) * 5) > threshold)
    if style == 27:
        cells = 17
        cx, cy = (np.floor(X * cells) + 0.5) / cells, (np.floor(Y * cells) + 0.5) / cells
        density = np.exp(-np.abs(sdf(cx, cy)) * 5)
        radius = 0.48 * np.sqrt(density) / cells
        dots = 1 - smooth(radius - AA / 2, radius + AA / 2, np.hypot(X - cx, Y - cy))
        return mix(PAPER, INK, dots)
    if style in [28, 29]:
        density = np.exp(-np.abs(D) * 5)
        lines = (np.sin((X + Y) * 105) > (1 - 1.8 * density)).astype(float)
        if style == 29:
            lines = np.maximum(lines, (np.sin((X - Y) * 105) > 0.2) * (density > 0.6))
        return mix(PAPER, INK, lines)
    if style == 30:
        rough = D + 0.13 * (N - 0.5)
        return mix(PAPER, INK, 1 - smooth(-AA, AA, rough))
    if style == 31:
        burn = D + 0.32 * (N - 0.30) + 0.04
        col = mix(INK, [0.77, 0.18, 0.045], np.exp(-np.abs(burn) * 65))
        col = mix(col, ORANGE, band(burn, width=0.008))
        return mix(col, PAPER, 1 - smooth(-AA, AA, burn + 0.012))
    if style == 32:
        surface = palette(0.25 + 0.3 * noise(X * 11, Y * 11))
        return mix(INK, surface, band(D, width=0.065))
    if style == 49:
        da = np.hypot(X + 0.32, Y) - 0.32
        db = np.hypot(X - 0.32, Y) - 0.32
        v = (0.5 + 0.5 * np.cos(65 * da)) * (0.5 + 0.5 * np.cos(65 * db))
        return mix(INK, TEAL, v)
    if style == 50:
        da = sdf(X + 0.55, Y)
        db = np.hypot(X - 0.55, Y) - 0.38
        col = mix([0.27, 0.40, 0.60], [0.87, 0.47, 0.29], (db < da).astype(float))
        return mix(col, PAPER, np.maximum(contours(np.minimum(da, db), 0.12, 0.004), band(da - db, width=0.009)))
    if style == 55:
        cells = 6
        dc = sdf((np.floor(X * cells) + 0.5) / cells, (np.floor(Y * cells) + 0.5) / cells)
        col = mix([0.27, 0.48, 0.68], PAPER, np.clip(0.5 + dc, 0, 1))
        grid = ((X * cells) % 1 < 0.025) | ((Y * cells) % 1 < 0.025)
        return mix(col, INK, grid * 0.3)
    if style == 33:
        return np.stack((0.5 + 0.5 * NX, 0.5 + 0.5 * NY, np.full_like(D, 0.55)), -1)
    if style == 34:
        return palette(THETA / TAU)
    if style == 35:
        return mix(mix(PAPER, [0.75, 0.86, 0.86], FILL), INK, EDGE * 0.8)
    if style == 38:
        qx, qy = X - D * GX, Y - D * GY
        checks = (np.floor(qx * 9) + np.floor(qy * 9)) % 2
        return mix([0.12, 0.28, 0.43], [0.82, 0.92, 0.77], checks)
    if style == 39:
        _, light = relief(0.23 * np.clip(-D / 0.11, 0, 1))
        return mix(INK, light[..., None] * TEAL, FILL)
    if style == 40:
        _, light = relief(-0.13 * (1 - smooth(-0.08, 0.02, D)))
        return np.clip(PAPER * (0.45 + light[..., None] * 0.65), 0, 1)
    if style == 41:
        spec = np.clip(RN @ np.array([-0.22, 0.32, 0.92]), 0, 1) ** 35
        return mix(INK, TEAL * (0.2 + LIT[..., None] * 0.8) + spec[..., None] * 0.5, FILL)
    if style == 42:
        steps = np.floor(LIT * 4) / 4
        return mix(PAPER, ORANGE * (0.18 + steps[..., None] * 0.82), FILL)
    if style == 43:
        # Analytic studio bands stand in for an environment texture.
        env = 0.5 + 0.5 * np.sin(13 * RN[..., 1] + 4 * RN[..., 0])
        chrome = np.array([0.76, 0.84, 0.94]) * (0.07 + 0.93 * env[..., None] ** 3)
        return mix(INK, chrome, FILL)
    if style == 45:
        def background(a, b):
            return mix([0.10, 0.25, 0.38], [0.73, 0.86, 0.75], ((np.floor(a * 7) + np.floor(b * 7)) % 2))
        shift = np.exp(-np.abs(D) * 11) * 0.11
        glass = background(X + NX * shift, Y + NY * shift)
        col = mix(background(X, Y), glass, FILL)
        return mix(col, [0.94, 0.99, 1], EDGE * 0.5)
    if style == 47:
        col = np.broadcast_to(PAPER, (H, W, 3)).copy()
        colors = [[0.24, 0.37, 0.47], [0.33, 0.51, 0.57], [0.43, 0.67, 0.67], [0.66, 0.83, 0.74]]
        for i, color in zip([3, 2, 1, 0], colors):
            level = i * 0.10
            shadow = 1 - smooth(-0.01, 0.04, sdf(X - 0.025, Y + 0.03) - level)
            col = mix(col, INK, shadow * 0.25)
            col = mix(col, color, 1 - smooth(-AA, AA, D - level))
        return col
    if style == 48:
        col = np.broadcast_to(INK, (H, W, 3)).copy()
        for t in np.linspace(1, 0, 48):
            side = 1 - smooth(-AA, AA, sdf(X - 0.20 * t, Y + 0.17 * t))
            col = mix(col, np.array([0.14, 0.45, 0.43]) * (1 - t * 0.3), side)
        return mix(col, TEAL, FILL)
    raise ValueError(style)


PLATES = [
    ("01-distance-and-edges", "DISTANCE & EDGES", [
        (11, "Signed grayscale"), (12, "Diverging ramp"), (14, "Quantized zones"), (16, "Major / minor contours"),
        (17, "Nonlinear contour spacing"), (18, "Zebra bands"), (19, "Sawtooth ramps"), (20, "Custom transfer ramp"),
        (2, "Boundary only"), (3, "Double outline"), (6, "Inner glow"), (23, "Fading contour echoes"),
    ]),
    ("02-pattern-and-texture", "PATTERN & TEXTURE", [
        (24, "Angular dashes"), (25, "Stipple density"), (26, "Ordered dithering"), (27, "Halftone dots"),
        (28, "Hatching"), (29, "Crosshatching"), (30, "Noisy boundary"), (31, "Burn / dissolve"),
        (32, "Textured border"), (49, "Two-field interference"), (50, "Nearest-shape regions"), (55, "Numeric sample grid"),
    ]),
    ("03-gradient-and-material", "GRADIENT & MATERIAL", [
        (33, "Gradient RGB"), (34, "Direction hue"), (35, "Gradient arrows"), (38, "Closest-point texture"),
        (39, "Directional bevel"), (40, "Debossed surface"), (41, "Rounded relief"), (42, "Toon relief"),
        (43, "Chrome approximation"), (45, "Glass displacement"), (47, "Paper-cut layers"), (48, "Faux extrusion"),
    ]),
]


def font(size, bold=False):
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    return ImageFont.truetype(f"/usr/share/fonts/truetype/dejavu/{name}", size)


def pixel(px, py):
    return (px - x[0]) / (x[-1] - x[0]) * (W - 1), (py - y[0]) / (y[-1] - y[0]) * (H - 1)


def annotate(im, style):
    draw = ImageDraw.Draw(im)
    if style == 35:
        for py in np.arange(-0.8, 0.9, 0.2):
            for px in np.arange(-1.2, 1.3, 0.2):
                eps = 0.001
                gx = (sdf(px + eps, py) - sdf(px - eps, py)) / (2 * eps)
                gy = (sdf(px, py + eps) - sdf(px, py - eps)) / (2 * eps)
                length = np.hypot(gx, gy)
                if length < 0.1:
                    continue
                gx, gy = float(gx / length), float(gy / length)
                tip = np.array([px, py]) + np.array([gx, gy]) * 0.095
                draw.line([pixel(px, py), pixel(*tip)], fill="#365e70", width=2)
                for side in [-1, 1]:
                    wing = tip - np.array([gx, gy]) * 0.028 + np.array([-gy, gx]) * 0.017 * side
                    draw.line([pixel(*tip), pixel(*wing)], fill="#365e70", width=2)
    if style == 55:
        for cy in (np.arange(-5, 6) + 0.5) / 6:
            for cx in (np.arange(-8, 8) + 0.5) / 6:
                draw.text(pixel(cx, cy), f"{float(sdf(cx, cy)):+.1f}", font=font(11), fill="#233444", anchor="mm")


def main():
    OUT.mkdir(exist_ok=True)
    for filename, title, styles in PLATES:
        sheet = Image.new("RGB", (1464, 1036), "#101722")
        draw = ImageDraw.Draw(sheet)
        draw.text((28, 22), "SDF  /  " + title, font=font(26, True), fill="#eff5f1")
        draw.text((28, 62), "Original mathematical previews · numbers match the research catalogue", font=font(16), fill="#a9b8c9")
        for i, (number, name) in enumerate(styles):
            values = render(number)
            if values.shape != (H, W, 3) or not np.isfinite(values).all():
                raise ValueError(f"Invalid render for {number}: {values.shape}")
            im = Image.fromarray(np.uint8(np.clip(values, 0, 1) * 255))
            annotate(im, number)
            im.save(OUT / f"style-{number:02d}.png")
            tx, ty = 28 + (i % 4) * 358, 104 + (i // 4) * 294
            sheet.paste(im.resize((334, 236), Image.Resampling.LANCZOS), (tx, ty))
            draw.text((tx, ty + 247), f"{number:02d}  {name}", font=font(15, True), fill="#e8efec")
        draw.text((28, 1004), "Same exact polygon SDF, except the two-field studies 49–50. Illustrations, not GPU performance tests.", font=font(14), fill="#a9b8c9")
        sheet.save(OUT / f"{filename}.png")
        sheet.save(OUT / f"{filename}.pdf", resolution=150)
        print(f"Rendered {filename}: {len(styles)} swatches")


if __name__ == "__main__":
    main()
