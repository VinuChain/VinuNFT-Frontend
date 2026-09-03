import assert from "node:assert/strict";
import test from "node:test";

const { sniffImage } = await import("../src/common/imageSniff.js");

// --- fixtures: real headers, built byte-by-byte ------------------------------

function png(width, height) {
    const b = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(width, 16);
    b.writeUInt32BE(height, 20);
    return b;
}

function gif(width, height, magic = "GIF89a") {
    const b = Buffer.alloc(10);
    b.write(magic, 0, "ascii");
    b.writeUInt16LE(width, 6);
    b.writeUInt16LE(height, 8);
    return b;
}

function jpeg(width, height, { leadingSegment = true } = {}) {
    const parts = [Buffer.from([0xff, 0xd8])];
    if (leadingSegment) {
        // A JFIF APP0 segment ahead of the frame header, as real encoders emit.
        const app0 = Buffer.alloc(18);
        app0.writeUInt8(0xff, 0);
        app0.writeUInt8(0xe0, 1);
        app0.writeUInt16BE(16, 2);
        app0.write("JFIF\0", 4, "ascii");
        parts.push(app0);
    }
    const sof = Buffer.alloc(11);
    sof.writeUInt8(0xff, 0);
    sof.writeUInt8(0xc0, 1);
    sof.writeUInt16BE(8, 2);
    sof.writeUInt8(8, 4);
    sof.writeUInt16BE(height, 5);
    sof.writeUInt16BE(width, 7);
    return Buffer.concat([...parts, sof, Buffer.alloc(8)]);
}

function webpVp8x(width, height) {
    const b = Buffer.alloc(30);
    b.write("RIFF", 0, "ascii");
    b.write("WEBP", 8, "ascii");
    b.write("VP8X", 12, "ascii");
    b.writeUIntLE(width - 1, 24, 3);
    b.writeUIntLE(height - 1, 27, 3);
    return b;
}

// --- happy paths ------------------------------------------------------------

test("identifies PNG with its IHDR dimensions", () => {
    assert.deepEqual(sniffImage(png(1920, 1080)), {
        mediaType: "image/png", width: 1920, height: 1080,
    });
});

test("identifies GIF87a and GIF89a", () => {
    for (const magic of ["GIF87a", "GIF89a"]) {
        assert.deepEqual(sniffImage(gif(640, 480, magic)), {
            mediaType: "image/gif", width: 640, height: 480,
        });
    }
});

test("identifies JPEG by walking past leading segments to the frame header", () => {
    assert.deepEqual(sniffImage(jpeg(800, 600)), {
        mediaType: "image/jpeg", width: 800, height: 600,
    });
    assert.deepEqual(sniffImage(jpeg(24, 42, { leadingSegment: false })), {
        mediaType: "image/jpeg", width: 24, height: 42,
    });
});

test("identifies extended WebP", () => {
    assert.deepEqual(sniffImage(webpVp8x(4096, 2160)), {
        mediaType: "image/webp", width: 4096, height: 2160,
    });
});

// --- adversarial ------------------------------------------------------------

test("rejects SVG, including a script-bearing one", () => {
    const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    );
    assert.equal(sniffImage(svg), null);
});

test("rejects HTML and JavaScript regardless of file name", () => {
    assert.equal(sniffImage(Buffer.from("<!DOCTYPE html><html><body>hi")), null);
    assert.equal(sniffImage(Buffer.from("#!/bin/sh\nrm -rf /")), null);
    assert.equal(sniffImage(Buffer.from("MZ\x90\x00")), null); // PE executable
});

test("rejects a truncated PNG signature", () => {
    assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null);
});

test("rejects a PNG signature whose first chunk is not IHDR", () => {
    const b = png(10, 10);
    b.write("IDAT", 12, "ascii");
    assert.equal(sniffImage(b), null);
});

test("rejects a zero-dimension image", () => {
    assert.equal(sniffImage(png(0, 100)), null);
    assert.equal(sniffImage(png(100, 0)), null);
});

test("a GIF polyglot carrying HTML is still identified as a GIF, not HTML", () => {
    // GIF headers are a classic polyglot carrier. The sniffer must report what
    // the bytes actually start as, so the endpoint compares against that.
    const poly = Buffer.concat([gif(1, 1), Buffer.from("<script>alert(1)</script>")]);
    assert.equal(sniffImage(poly).mediaType, "image/gif");
});

test("reports the declared geometry of a decompression bomb without decoding", () => {
    const bomb = sniffImage(png(60000, 60000));
    assert.equal(bomb.width * bomb.height, 3600000000);
});

test("rejects empty input", () => {
    assert.equal(sniffImage(Buffer.alloc(0)), null);
});

/** A GIF with a logical screen and real image descriptors after it. */
function animatedGif(canvas, frames) {
    // The logical screen descriptor is 7 bytes: the two dimensions the `gif`
    // helper writes, then flags (no global colour table), background index and
    // pixel aspect ratio.
    const parts = [
        gif(canvas.width, canvas.height),
        Buffer.from([0x00, 0x00, 0x00]),
    ];
    for (const frame of frames) {
        const descriptor = Buffer.alloc(10);
        descriptor.writeUInt8(0x2c, 0);
        descriptor.writeUInt16LE(frame.left ?? 0, 1);
        descriptor.writeUInt16LE(frame.top ?? 0, 3);
        descriptor.writeUInt16LE(frame.width, 5);
        descriptor.writeUInt16LE(frame.height, 7);
        descriptor.writeUInt8(0, 9); // no local colour table
        // LZW minimum code size, one data sub-block, block terminator.
        parts.push(descriptor, Buffer.from([0x02, 0x01, 0x00, 0x00]));
    }
    parts.push(Buffer.from([0x3b]));
    return Buffer.concat(parts);
}

test("a GIF is bounded by its frames, not only by its logical canvas", () => {
    // The logical screen is the canvas frames composite onto; each frame
    // carries its own geometry. A 1x1 canvas passes any pixel bound while a
    // decoder that allocates per frame is asked for 65535x65535.
    const bomb = animatedGif({ width: 1, height: 1 }, [
        { width: 65535, height: 65535 },
    ]);
    const sniffed = sniffImage(bomb);

    assert.equal(sniffed.mediaType, "image/gif");
    assert.ok(
        sniffed.width * sniffed.height >= 65535 * 65535,
        `the geometry the guard sees must include the frame, got ${sniffed.width}x${sniffed.height}`
    );
});

test("an ordinary animated GIF still reports its own size", () => {
    const normal = animatedGif({ width: 40, height: 30 }, [
        { width: 40, height: 30 },
        { left: 4, top: 4, width: 8, height: 8 },
    ]);
    assert.deepEqual(sniffImage(normal), {
        mediaType: "image/gif",
        width: 40,
        height: 30,
    });
});
