import TextNFT from "../abis/TextNFT.json";
import ImageNFT from "../abis/ImageNFT.json";
import Marketplace from "../abis/Marketplace.json";

const v1 = {
    text: TextNFT.abi,
    marketplace: Marketplace.abi,
    image: ImageNFT.abi,
};

export { v1 };
