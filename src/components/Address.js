import React from "react";
import config from "../config";
import RoutingLink from "./RoutingLink";

import { useEns } from "../common/ens";

import { shortenAddress } from "../common/utils";

export default function Address({
    address,
    shorten,
    nChar,
    disableLink,
    external,
}) {
    const { lookupEns } = useEns();
    const label =
        lookupEns(address) ||
        (shorten ? shortenAddress(address, nChar) : address);

    return (
        <span>
            {disableLink ? (
                label
            ) : external ? (
                <a
                    target="_blank"
                    rel="noreferrer"
                    href={config.blockExplorer.url + "/address/" + address}
                    style={{ textDecoration: "underline" }}
                >
                    {label}
                </a>
            ) : (
                <RoutingLink
                    href={`/address?address=${encodeURIComponent(address)}`}
                    style={{ textDecoration: "underline" }}
                >
                    {label}
                </RoutingLink>
            )}
        </span>
    );
}
