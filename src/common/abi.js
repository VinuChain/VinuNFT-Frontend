import ZangNFT from "../abis/ZangNFT.json";
import ImageNFT from "../abis/ImageNFT.json";
import Marketplace from "../abis/Marketplace.json";

const v1 = {
    zang: ZangNFT.abi,
    marketplace: Marketplace.abi,
    image: ImageNFT.abi,
};

export { v1 };
