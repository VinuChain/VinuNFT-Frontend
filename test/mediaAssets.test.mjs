import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaAssets, mediaGroups } from "../src/common/mediaAssets.js";

test("media kit exposes the VinuNFT brand asset group", () => {
    assert.equal(mediaGroups.length, 1);
    assert.equal(mediaGroups[0].id, "vinunft");
    assert.equal(mediaGroups[0].label, "VinuNFT Brand");
});

test("media kit includes downloadable VinuNFT logo assets", () => {
    const ids = mediaAssets.map((asset) => asset.id);

    assert.ok(ids.includes("vinunft-logo-png"));
    assert.ok(ids.includes("vinunft-favicon"));

    const png = mediaAssets.find((asset) => asset.id === "vinunft-logo-png");
    assert.equal(png.href, "/vinunft.png");
    assert.equal(png.format, "PNG");
    assert.equal(png.dimensions, "1430x1613");
});
