import React from "react";
import RoutingLink from "./RoutingLink";

function bridgeHref({ token, direction }) {
    const params = new URLSearchParams();
    if (token) {
        params.set("token", token);
    }
    if (direction) {
        params.set("direction", direction);
    }

    const query = params.toString();
    return query ? `/bridge?${query}` : "/bridge";
}

export default function BridgeShortcut({
    token,
    direction = "into",
    variant = "quiet",
    children,
}) {
    const tokenLabel = token ? token.toUpperCase() : "tokens";
    const label = children || `Bridge ${tokenLabel} to VinuChain`;

    return (
        <RoutingLink
            href={bridgeHref({ token: tokenLabel, direction })}
            className={`bridge-shortcut bridge-shortcut--${variant}`}
            aria-label={label}
        >
            {label}
        </RoutingLink>
    );
}
