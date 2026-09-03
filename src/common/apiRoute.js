/**
 * Build the URL for one of this site's own serverless functions.
 *
 * The deployment canonicalises `/api/foo` to `/api/foo/` and answers the
 * unslashed form with a 308. The redirect is harmless — 308 preserves the
 * method and body, so a POST still arrives — but it costs an extra round trip
 * on every upload and every bridge call. Requesting the canonical form skips
 * it.
 *
 * Verified against the deployment: `/api/upload-ipfs` returns 308 to
 * `/api/upload-ipfs/`, which then answers 405 to GET and 400 to an empty POST.
 */
export function apiRoute(name, search) {
    if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("apiRoute: name is required");
    }

    const path = withTrailingSlash(`/api/${name}`);
    return search ? `${path}?${search}` : path;
}

/**
 * Add the trailing slash to a path, leaving any query or fragment where it is.
 * An absolute URL is handled too, because `GATSBY_IPFS_UPLOAD_ENDPOINT` may
 * point the upload at another host when the site is served statically.
 */
export function withTrailingSlash(endpoint) {
    if (typeof endpoint !== "string" || endpoint.length === 0) {
        return endpoint;
    }

    const split = endpoint.search(/[?#]/);
    const path = split === -1 ? endpoint : endpoint.slice(0, split);
    const rest = split === -1 ? "" : endpoint.slice(split);

    return path.endsWith("/") ? endpoint : `${path}/${rest}`;
}
