import { PinataSDK } from "pinata";

const pinata = new PinataSDK({
    pinataJwt: process.env.GATSBY_PINATA_API_JWT,
    pinataGateway: process.env.GATSBY_PINATA_GATEWAY,
});

async function uploadFileToIpfs(image) {
    console.log(image);
    try {
        const upload = await pinata.upload.file(image);
        console.log(upload);
        return upload.IpfsHash;
    } catch (error) {
        console.log(error);
    }
}

async function uploadJSONToIpfs(json) {
    try {
        const upload = await pinata.upload.json(json);
        console.log(upload);
        return upload.IpfsHash;
    } catch (error) {
        console.log(error);
    }
}

export { uploadFileToIpfs, uploadJSONToIpfs };
