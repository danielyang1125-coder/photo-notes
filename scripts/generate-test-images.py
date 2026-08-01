#!/usr/bin/env python3
"""Generate standardized test images for the photo-notes miniprogram testing.

Produces ~45 images across 6 categories covering format validation, file size
boundaries, dimension extremes, EXIF metadata, compression pipeline, and
edge/corrupt cases.

Usage:
    python scripts/generate-test-images.py          # generate all images
    python scripts/generate-test-images.py --clean  # remove all generated images

Total output: ~150 MB in test/fixtures/images/
"""

import argparse
import io
import os
import random
import shutil
import struct
import sys
from pathlib import Path

# Force UTF-8 output on Windows
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import piexif
from PIL import Image, ImageDraw

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = ROOT / "test" / "fixtures" / "images"

# Limits from miniprogram/utils/constants.js
MAX_SIZE_BYTES = 20 * 1024 * 1024       # 20 MB
COMPRESS_MAX_EDGE = 2560                  # longest edge limit
COMPRESS_TARGET_SIZE = 3 * 1024 * 1024    # 3 MB target

# Test EXIF date: 2024-06-15 14:30:00
EXIF_DATE_STR = "2024:06:15 14:30:00"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def ensure_dir(path: Path):
    path.mkdir(parents=True, exist_ok=True)


def make_jpg(path: Path, width: int, height: int, quality: int = 85,
             exif_bytes: bytes | None = None, color=(180, 120, 80)):
    """Create a JPG with colored background and optional EXIF data."""
    img = Image.new("RGB", (width, height), color)
    # Add some visual content so it's not a solid block
    draw = ImageDraw.Draw(img)
    for i in range(0, width, 40):
        draw.line([(i, 0), (i, height)], fill=(color[0]+30, color[1]+20, color[2]+10), width=1)
    for i in range(0, height, 40):
        draw.line([(0, i), (width, i)], fill=(color[0]+10, color[1]+30, color[2]+20), width=1)
    # Add text label
    draw.text((10, 10), f"{path.stem}\n{width}x{height}", fill=(255, 255, 255))

    save_args = {"format": "JPEG", "quality": quality}
    if exif_bytes is not None:
        save_args["exif"] = exif_bytes
    img.save(path, **save_args)


def make_png(path: Path, width: int, height: int, rgba=(200, 160, 100, 128)):
    """Create a PNG, optionally with transparency."""
    mode = "RGBA" if len(rgba) == 4 else "RGB"
    img = Image.new(mode, (width, height), rgba)
    draw = ImageDraw.Draw(img)
    for i in range(0, width, 40):
        color = (rgba[0]+30, rgba[1]+20, rgba[2]+10, rgba[3] if len(rgba)==4 else 255)
        draw.line([(i, 0), (i, height)], fill=color[:4] if len(rgba)==4 else color, width=1)
    draw.text((10, 10), f"{path.stem}\n{width}x{height}", fill=(255, 255, 255, 255))
    img.save(path, format="PNG")


def make_exif(date_str: str) -> bytes:
    """Create EXIF bytes with DateTimeOriginal set."""
    zeroth_ifd = {
        piexif.ImageIFD.DateTime: date_str,
        piexif.ImageIFD.Make: "TestCamera",
        piexif.ImageIFD.Model: "PhotoNotesTest",
    }
    exif_ifd = {
        piexif.ExifIFD.DateTimeOriginal: date_str,
        piexif.ExifIFD.DateTimeDigitized: date_str,
    }
    return piexif.dump({"0th": zeroth_ifd, "Exif": exif_ifd})


def make_partial_exif(date_str: str) -> bytes:
    """EXIF with Make/Model but no DateTimeOriginal."""
    zeroth_ifd = {
        piexif.ImageIFD.DateTime: date_str,
        piexif.ImageIFD.Make: "TestCamera",
        piexif.ImageIFD.Model: "PhotoNotesTest",
    }
    exif_ifd = {}  # No DateTimeOriginal
    return piexif.dump({"0th": zeroth_ifd, "Exif": exif_ifd})


def make_sized_jpg(path: Path, target_bytes: int, base_width=4000, base_height=3000,
                   quality_start=95):
    """Generate a JPG approximating target_bytes.

    Strategy:
      - Small targets (<500KB): tiny dimensions + low quality
      - Medium targets (500KB-5MB): moderate dimensions + binary search quality
      - Large targets (5-18MB): large dims + random noise (harder to compress) + max quality
      - Near/at limit (18-20MB): same as large, then pad with APP1 markers to hit exact target
      - Over limit (>20MB): large dims + pad to exceed 20MB
    """
    import random as _random

    # Determine dimensions based on target size
    if target_bytes < 10 * 1024:
        w, h = 50, 38
    elif target_bytes < 200 * 1024:
        w, h = 800, 600
    elif target_bytes < 3 * 1024 * 1024:
        w, h = base_width, base_height
    elif target_bytes < 15 * 1024 * 1024:
        w, h = 6000, 4500
    else:
        w, h = 9000, 6750

    # For targets >= 5MB, use random noise which is much harder to compress
    # (gradient patterns compress too efficiently with JPEG)
    if target_bytes >= 5 * 1024 * 1024:
        # Create image with per-pixel random noise
        pixels = bytearray(w * h * 3)
        _rand = _random.Random(42)  # deterministic seed for reproducibility
        for i in range(0, len(pixels), 3):
            val = _rand.randint(0, 255)
            pixels[i] = val
            pixels[i+1] = val
            pixels[i+2] = val
        img = Image.frombytes("RGB", (w, h), bytes(pixels))
    else:
        img = Image.new("RGB", (w, h), (100, 150, 200))
        draw = ImageDraw.Draw(img)
        step = max(h // 200, 1)
        for y in range(0, h, step):
            r = int(100 + 80 * (y / h))
            g = int(150 + 60 * ((y * 1.5) % h / h))
            b = int(200 - 60 * (y / h))
            draw.line([(0, y), (w, min(y + step - 1, h - 1))], fill=(r, g, b), width=1)

    # Encode and check size
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=100)
    max_size = buf.tell()

    # Binary search quality only if max is above target
    if max_size > target_bytes:
        lo, hi = 2, 100
        best_quality = 100
        for _ in range(15):
            mid = max((lo + hi) // 2, 2)
            buf.seek(0)
            buf.truncate()
            img.save(buf, format="JPEG", quality=mid)
            size = buf.tell()
            if size <= 0:
                break
            if abs(size - target_bytes) / target_bytes < 0.08:
                best_quality = mid
                break
            if size > target_bytes:
                hi = mid
            else:
                lo = mid + 1
            best_quality = mid
        buf.seek(0)
        buf.truncate()
        img.save(buf, format="JPEG", quality=max(best_quality, 2))
    # else: max_size <= target_bytes, keep quality=100 result

    final_size = buf.tell()
    with open(path, "wb") as f:
        f.write(buf.getvalue())

    # Pad with APP1 markers to reach target (for sizes >= 18MB where exactness matters)
    if target_bytes >= 18 * 1024 * 1024 and final_size < target_bytes:
        padding_needed = target_bytes - final_size
        with open(path, "ab") as f:
            while padding_needed > 0:
                # JPEG APP1 segment: FF E1 + 2-byte big-endian length + data
                # Length field includes itself (2 bytes), so max payload = 65533
                n = min(padding_needed, 65533)
                if n <= 0:
                    break
                f.write(b"\xff\xe1")
                f.write(struct.pack(">H", n + 2))
                f.write(b"\x00" * n)
                padding_needed -= (2 + 2 + n)

    return os.path.getsize(path)


# ---------------------------------------------------------------------------
# Generators per category
# ---------------------------------------------------------------------------

def generate_formats():
    """Generate valid and invalid format test images."""
    d = OUTPUT_DIR / "formats"
    ensure_dir(d / "valid")
    ensure_dir(d / "invalid")

    exif_bytes = make_exif(EXIF_DATE_STR)

    # Valid formats
    make_jpg(d / "valid" / "sample.jpg", 1920, 1080, quality=85, exif_bytes=exif_bytes)
    make_jpg(d / "valid" / "sample.jpeg", 1920, 1080, quality=85, exif_bytes=exif_bytes)
    make_png(d / "valid" / "sample.png", 1920, 1080, (180, 130, 90, 255))
    make_png(d / "valid" / "sample-transparent.png", 800, 600, (200, 160, 100, 128))

    # Invalid formats
    img = Image.new("RGB", (400, 300), (200, 100, 50))
    img.save(d / "invalid" / "animated.gif", format="GIF")
    img.save(d / "invalid" / "sample.bmp", format="BMP")
    img.save(d / "invalid" / "sample.webp", format="WEBP")

    # SVG (text file, not an image)
    d_inv = d / "invalid"
    d_inv.joinpath("sample.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">'
        '<rect width="100" height="100" fill="red"/></svg>'
    )

    print("  ✓ formats/")


def generate_sizes():
    """Generate various file size test images."""
    d = OUTPUT_DIR / "sizes"
    ensure_dir(d)

    # Create a reference image for consistent sizing
    cases = [
        ("tiny-1kb.jpg", 1 * 1024),
        ("small-100kb.jpg", 100 * 1024),
        ("normal-3mb.jpg", COMPRESS_TARGET_SIZE),
        ("near-limit-18mb.jpg", 18 * 1024 * 1024),
        ("exactly-20mb.jpg", MAX_SIZE_BYTES),
        ("over-limit-21mb.jpg", 21 * 1024 * 1024),
        ("over-limit-25mb.jpg", 25 * 1024 * 1024),
    ]

    for name, target in cases:
        path = d / name
        actual = make_sized_jpg(path, target)
        status = "✓" if actual >= target * 0.9 else "⚠"
        print(f"    {status} {name}: {actual/1024:.0f} KB (target {target/1024:.0f} KB)")

    # 0-byte file
    (d / "zero-byte.jpg").write_bytes(b"")
    print(f"    ✓ zero-byte.jpg: 0 bytes")

    print("  ✓ sizes/")


def generate_dimensions():
    """Generate images with various dimensions."""
    d = OUTPUT_DIR / "dimensions"
    ensure_dir(d)

    dims = [
        ("small-100x100.jpg", 100, 100),
        ("normal-1920x1080.jpg", 1920, 1080),
        ("large-4000x3000.jpg", 4000, 3000),      # exceeds 2560 edge
        ("xlarge-8000x6000.jpg", 8000, 6000),       # far exceeds 2560 edge
        ("narrow-1x1000.png", 1, 1000),
        ("wide-5000x1.png", 5000, 1),
        ("portrait-1080x2400.jpg", 1080, 2400),
    ]

    for name, w, h in dims:
        path = d / name
        if name.endswith(".png"):
            make_png(path, w, h)
        else:
            make_jpg(path, w, h, quality=60)  # lower quality for large dims
        print(f"    ✓ {name}: {w}x{h} ({os.path.getsize(path)/1024:.0f} KB)")

    print("  ✓ dimensions/")


def generate_exif():
    """Generate images with different EXIF states."""
    d = OUTPUT_DIR / "exif"
    ensure_dir(d)

    exif_bytes = make_exif(EXIF_DATE_STR)
    partial_exif_bytes = make_partial_exif(EXIF_DATE_STR)

    # With full EXIF date
    make_jpg(d / "with-exif-date.jpg", 1920, 1080, quality=85, exif_bytes=exif_bytes)
    print("    ✓ with-exif-date.jpg (DateTimeOriginal set)")

    # No EXIF
    make_jpg(d / "no-exif.jpg", 1920, 1080, quality=85)
    print("    ✓ no-exif.jpg (no EXIF data)")

    # Partial EXIF (no DateTimeOriginal)
    make_jpg(d / "partial-exif.jpg", 1920, 1080, quality=85,
             exif_bytes=partial_exif_bytes)
    print("    ✓ partial-exif.jpg (EXIF without DateTimeOriginal)")

    # Non-standard EXIF format: swap endianness or use GPS-only
    zeroth = {piexif.ImageIFD.Make: "TestCamera"}
    gps = {
        piexif.GPSIFD.GPSLatitudeRef: "N",
        piexif.GPSIFD.GPSLatitude: ((31, 1), (13, 1), (51, 100)),
        piexif.GPSIFD.GPSLongitudeRef: "E",
        piexif.GPSIFD.GPSLongitude: ((121, 1), (26, 1), (38, 100)),
    }
    gps_exif = piexif.dump({"0th": zeroth, "GPS": gps})
    make_jpg(d / "different-exif-format.jpg", 1920, 1080, quality=85, exif_bytes=gps_exif)
    print("    ✓ different-exif-format.jpg (GPS only, no DateTimeOriginal)")

    print("  ✓ exif/")


def generate_compression():
    """Generate images for compression pipeline testing."""
    d = OUTPUT_DIR / "compression"
    ensure_dir(d)

    # High-quality raw (simulates smartphone output)
    img = Image.new("RGB", (4000, 3000), (120, 180, 240))
    draw = ImageDraw.Draw(img)
    # Add complex gradient patterns (harder to compress)
    for y in range(0, 3000, 1):
        r = int(120 + 100 * (y / 3000) + 30 * ((y * 3) % 3000 / 3000))
        g = int(180 + 50 * (y / 3000) + 30 * ((y * 7) % 3000 / 3000))
        b = int(240 - 40 * (y / 3000) + 30 * ((y * 5) % 3000 / 3000))
        draw.line([(0, y), (4000, y)], fill=(r, g, b), width=1)
    img.save(d / "high-quality-raw.jpg", format="JPEG", quality=100)
    print(f"    ✓ high-quality-raw.jpg ({os.path.getsize(d / 'high-quality-raw.jpg')/1024:.0f} KB)")

    # Already-optimized (low quality, small size)
    img2 = Image.new("RGB", (800, 600), (80, 80, 80))
    draw2 = ImageDraw.Draw(img2)
    draw2.rectangle([(200, 150), (600, 450)], fill=(150, 150, 150))
    draw2.text((10, 10), "already optimized", fill=(255, 255, 255))
    img2.save(d / "already-optimized.jpg", format="JPEG", quality=30)
    print(f"    ✓ already-optimized.jpg ({os.path.getsize(d / 'already-optimized.jpg')/1024:.0f} KB)")

    # Color profile: sRGB
    img3 = Image.new("RGB", (1920, 1080), (100, 200, 100))
    img3.save(d / "color-profile-srgb.jpg", format="JPEG", quality=85, icc_profile=None)  # sRGB is default
    print(f"    ✓ color-profile-srgb.jpg")

    # Color profile: Adobe RGB (simulated — Pillow doesn't embed profiles easily)
    img4 = Image.new("RGB", (1920, 1080), (200, 150, 100))
    img4.save(d / "color-profile-adobe.jpg", format="JPEG", quality=85)
    print(f"    ✓ color-profile-adobe.jpg")

    # Progressive JPEG
    img5 = Image.new("RGB", (1920, 1080), (80, 130, 200))
    draw5 = ImageDraw.Draw(img5)
    draw5.text((10, 10), "Progressive JPEG", fill=(255, 255, 255))
    img5.save(d / "progressive-jpeg.jpg", format="JPEG", quality=85, progressive=True)
    print(f"    ✓ progressive-jpeg.jpg")

    print("  ✓ compression/")


def generate_corrupt():
    """Generate corrupt/edge-case files."""
    d = OUTPUT_DIR / "corrupt"
    ensure_dir(d)

    # Truncated JPG: create a valid JPG, then truncate it
    buf = io.BytesIO()
    img = Image.new("RGB", (800, 600), (100, 100, 200))
    img.save(buf, format="JPEG", quality=85)
    full_data = buf.getvalue()
    half = len(full_data) // 2
    (d / "truncated.jpg").write_bytes(full_data[:half])
    print(f"    ✓ truncated.jpg ({half} of {len(full_data)} bytes)")

    # PNG content saved with .jpg extension (tests frontend extension check vs backend magic bytes)
    buf2 = io.BytesIO()
    img2 = Image.new("RGBA", (400, 300), (200, 150, 100, 200))
    img2.save(buf2, format="PNG")
    (d / "fake-jpg.png").write_bytes(buf2.getvalue())
    print(f"    ✓ fake-jpg.png (PNG content, .jpg extension — {os.path.getsize(d / 'fake-jpg.png')/1024:.0f} KB)")

    # No extension file (valid JPEG content)
    buf3 = io.BytesIO()
    img3 = Image.new("RGB", (400, 300), (80, 80, 80))
    img3.save(buf3, format="JPEG", quality=85)
    (d / "no-extension").write_bytes(buf3.getvalue())
    print(f"    ✓ no-extension (JPEG content, no extension)")

    print("  ✓ corrupt/")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Generate test images for photo-notes")
    parser.add_argument("--clean", action="store_true", help="Remove all generated images")
    args = parser.parse_args()

    if args.clean:
        if OUTPUT_DIR.exists():
            shutil.rmtree(OUTPUT_DIR)
            print(f"Removed: {OUTPUT_DIR}")
        else:
            print(f"Nothing to clean: {OUTPUT_DIR} does not exist")
        return

    print(f"Generating test images in: {OUTPUT_DIR}")
    print()

    ensure_dir(OUTPUT_DIR)

    print("Generating formats/ ...")
    generate_formats()

    print("Generating sizes/ ...")
    generate_sizes()

    print("Generating dimensions/ ...")
    generate_dimensions()

    print("Generating exif/ ...")
    generate_exif()

    print("Generating compression/ ...")
    generate_compression()

    print("Generating corrupt/ ...")
    generate_corrupt()

    # Summary
    total_size = sum(
        f.stat().st_size
        for f in OUTPUT_DIR.rglob("*")
        if f.is_file()
    )
    total_count = sum(1 for f in OUTPUT_DIR.rglob("*") if f.is_file())
    print(f"\nDone! Generated {total_count} test images, total {total_size/1024/1024:.1f} MB")
    print(f"Output: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
