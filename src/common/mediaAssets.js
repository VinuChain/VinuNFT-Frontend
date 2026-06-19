const mediaGroups = [
    {
        id: "vinunft",
        label: "VinuNFT Brand",
        blurb: "Official VinuNFT marks for marketplace pages, partner listings, and social posts.",
    },
];

const mediaAssets = [
    {
        id: "vinunft-logo-png",
        title: "VinuNFT Logo - PNG",
        description:
            "Large transparent VinuNFT logo used by the marketplace app. Best for app pages, ecosystem announcements, and partner directories.",
        format: "PNG",
        dimensions: "1430x1613",
        href: "/vinunft.png",
        group: "vinunft",
        preview: "transparent",
    },
    {
        id: "vinunft-favicon",
        title: "VinuNFT Favicon",
        description:
            "Square browser and app icon used for VinuNFT tabs, bookmarks, and compact placements.",
        format: "ICO",
        dimensions: "256x256",
        href: "/favicon.ico",
        previewSrc: "/vinunft.png",
        group: "vinunft",
        preview: "light",
    },
];

function fileNameFromHref(href) {
    return href.replace(/^.*\//, "");
}

export { fileNameFromHref, mediaAssets, mediaGroups };
