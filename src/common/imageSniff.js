/**
 * Minimal image identification from the leading bytes of a file.
 *
 * The upload endpoint must not trust the content type a client declares: a
 * caller can label a script, an HTML polyglot, or an SVG as `image/png` and
 * have it pinned and later served from a gateway. Identifying the format from
 * the bytes themselves, and requiring it to match what the client claimed, is
 * what makes the declared type meaningful.
 *
 * Dimensions come from the header rather than by decoding, so a decompression
 * bomb is rejected on its declared geometry without ever being expanded.
 */

const readU16BE = (b, o) => (b[o] << 8) | b[o + 1];
const readU16LE = (b, o) => b[o] | (b[o + 1] << 8);
const readU32BE = (b, o) =>
    ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const readU24LE = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

const startsWith = (bytes, sig, offset = 0) =>
    sig.every((v, i) => bytes[offset + i] === v);

const ascii = (bytes, offset, length) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function sniffPng(b) {
    // IHDR is required to be the first chunk: length(4) type(4) width(4) height(4)
    if (b.length < 24 || !startsWith(b, PNG_SIG)) return null;
    if (ascii(b, 12, 4) !== "IHDR") return null;
    return {
        mediaType: "image/png",
        width: readU32BE(b, 16),
        height: readU32BE(b, 20),
    };
}

/**
 * The largest image descriptor in a GIF, or null if the blocks cannot be walked.
 *
 * A GIF's logical screen is only the canvas its frames composite onto; each
 * frame carries its own width and height. A file can therefore declare a 1x1
 * canvas — passing any bound on the canvas alone — while asking a decoder that
 * allocates per frame for 65535x65535. Walking the block structure is enough to
 * see that, and costs no decoding.
 *
 * Best effort by design: a file whose blocks do not parse falls back to the
 * canvas, exactly as before. A frame hidden behind bytes no walker can follow
 * is a frame no decoder reaches either, and rejecting every unparseable GIF
 * would reject the polyglots and truncated files this sniffer exists to
 * identify rather than trust.
 */
function largestGifFrame(b) {
    const colourTableSize = (flags) =>
        flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0;
    // Header (6) + logical screen descriptor (7), then the global colour table.
    let offset = 13 + colourTableSize(b[10]);
    let largest = null;

    while (offset < b.length) {
        const block = b[offset];
        if (block === 0x3b) break; // trailer
        if (block === 0x21) {
            // Extension: introducer, label, then data sub-blocks.
            offset += 2;
        } else if (block === 0x2c) {
            const width = readU16LE(b, offset + 5);
            const height = readU16LE(b, offset + 7);
            if (offset + 10 > b.length) return largest;
            if (!largest || width * height > largest.width * largest.height) {
                largest = { width, height };
            }
            // Descriptor, local colour table, LZW minimum code size, then data.
            offset += 10 + colourTableSize(b[offset + 9]) + 1;
        } else {
            return largest;
        }
        // Skip the block's data sub-blocks: each is a length byte and that many
        // bytes, terminated by a zero length.
        while (offset < b.length && b[offset] !== 0) {
            offset += b[offset] + 1;
        }
        offset += 1;
    }

    return largest;
}

function sniffGif(b) {
    if (b.length < 10) return null;
    const magic = ascii(b, 0, 6);
    if (magic !== "GIF87a" && magic !== "GIF89a") return null;
    const canvas = { width: readU16LE(b, 6), height: readU16LE(b, 8) };
    // The geometry the pixel bound is applied to is whichever is larger: an
    // oversized frame costs the decoder what it declares, wherever the canvas
    // sits.
    const frame = largestGifFrame(b);
    const geometry =
        frame && frame.width * frame.height > canvas.width * canvas.height
            ? frame
            : canvas;
    return { mediaType: "image/gif", ...geometry };
}

function sniffJpeg(b) {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff)
        return null;

    // Walk the marker segments to the frame header that carries the geometry.
    let offset = 2;
    while (offset + 9 < b.length) {
        if (b[offset] !== 0xff) return null;
        const marker = b[offset + 1];
        if (
            marker === 0xd8 ||
            marker === 0x01 ||
            (marker >= 0xd0 && marker <= 0xd7)
        ) {
            offset += 2;
            continue;
        }
        const length = readU16BE(b, offset + 2);
        if (length < 2) return null;
        const isFrame =
            (marker >= 0xc0 && marker <= 0xc3) ||
            (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) ||
            (marker >= 0xcd && marker <= 0xcf);
        if (isFrame) {
            return {
                mediaType: "image/jpeg",
                height: readU16BE(b, offset + 5),
                width: readU16BE(b, offset + 7),
            };
        }
        offset += 2 + length;
    }
    return null;
}

function sniffWebp(b) {
    if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP")
        return null;
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8 ") {
        // Lossy: 3-byte start code, then 14-bit dimensions.
        return {
            mediaType: "image/webp",
            width: readU16LE(b, 26) & 0x3fff,
            height: readU16LE(b, 28) & 0x3fff,
        };
    }
    if (chunk === "VP8L") {
        // 14-bit width and height, each stored minus one, packed little-endian
        // after the 0x2f signature byte.
        const packed =
            (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
        return {
            mediaType: "image/webp",
            width: (packed & 0x3fff) + 1,
            height: ((packed >> 14) & 0x3fff) + 1,
        };
    }
    if (chunk === "VP8X") {
        return {
            mediaType: "image/webp",
            width: readU24LE(b, 24) + 1,
            height: readU24LE(b, 27) + 1,
        };
    }
    return null;
}

const SNIFFERS = [sniffPng, sniffGif, sniffJpeg, sniffWebp];

/**
 * Identify `bytes`, returning `{ mediaType, width, height }` or null when the
 * content is not one of the supported raster image formats. Anything script
 * bearing — SVG, HTML, JavaScript — fails to match and returns null.
 */
export function sniffImage(bytes) {
    for (const sniff of SNIFFERS) {
        const result = sniff(bytes);
        if (result && result.width > 0 && result.height > 0) return result;
    }
    return null;
}
