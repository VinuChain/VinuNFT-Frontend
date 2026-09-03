import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const mod = await import("../src/common/addressProfile.js");
const { profileSection, PROFILE_PAGE_SIZE } = mod.default || mod;

const refs = (n) =>
    Array.from({ length: n }, (_, i) => ({ type: "text", id: i + 1 }));

test("a section renders a bounded page and says what it is holding back", () => {
    // Every card reads its URI and its author, so an unbounded section is not a
    // long list, it is hundreds of simultaneous RPC and gateway requests.
    const many = profileSection(refs(100));
    assert.equal(many.rows.length, PROFILE_PAGE_SIZE);
    assert.equal(many.remaining, 100 - PROFILE_PAGE_SIZE);

    const few = profileSection(refs(3));
    assert.deepEqual(few.rows, refs(3));
    assert.equal(few.remaining, 0);

    assert.deepEqual(profileSection(undefined), { rows: [], remaining: 0 });
});

test("asking for more extends the same page rather than replacing it", () => {
    const all = refs(100);
    const first = profileSection(all);
    const second = profileSection(all, PROFILE_PAGE_SIZE * 2);

    assert.deepEqual(second.rows.slice(0, PROFILE_PAGE_SIZE), first.rows);
    assert.equal(second.remaining, 100 - PROFILE_PAGE_SIZE * 2);
});

test("the address page renders through the bound, not the whole profile", () => {
    const source = readFileSync("src/pages/address.js", "utf8");
    assert.match(source, /profileSection\(/);
    assert.equal(
        /profile\[key\]\.map\(/.test(source),
        false,
        "mapping the whole section mounts a card per token in one render"
    );
});
