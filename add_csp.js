const { createHash } = require("crypto");
const { Parser } = require("htmlparser2");
const fs = require("fs");
const path = require("path");

const TARGET_FOLDER = path.join(path.resolve(), "public");

function getHtmlFiles() {
    // Iterate recursively through the directory and return all HTML files

    const walk = (dir) => {
        let results = [];
        const list = fs.readdirSync(dir);
        list.forEach((file) => {
            file = path.join(dir, file);
            const stat = fs.statSync(file);
            if (stat && stat.isDirectory()) {
                results = results.concat(walk(file));
            } else {
                if (file.endsWith(".html")) {
                    results.push(file);
                }
            }
        });
        return results;
    };

    return walk(TARGET_FOLDER);
}

// The list of all hashes for inserting later via `gatsby-plugin-csp` settings
let scriptHashes = [];
// Iterates through the list of HTML files to calculate all hashes
// Note, I omitted the body of `getHtmlFiles()` method
getHtmlFiles(TARGET_FOLDER).forEach((file) => {
    const hashes = getShaFromTags(file, "script");
    addHashesToHtmlFile(file, hashes);
});

function computeHash(text) {
    return `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
}
// Return an array of hashes for <inputFilePath> file and the content of all instances of <tagName> tag
function getShaFromTags(inputFilePath, tagName) {
    console.log(`Getting '<${tagName}>' from ${inputFilePath}`);
    try {
        const fileContents = fs.readFileSync(inputFilePath, {
            encoding: "utf-8",
        });
        let hashes = [];

        let inScriptElement = false;

        const parser = new Parser(
            {
                onopentag: (name, _) => {
                    if (name === tagName) inScriptElement = true;
                },
                ontext: (text) => {
                    if (inScriptElement) {
                        hashes.push(computeHash(text));
                    }
                },
                onclosetag: (tagname) => {
                    if (tagname === "script") inScriptElement = false;
                },
            },
            { decodeEntities: true }
        );

        parser.write(fileContents);
        parser.end();

        let uniqueHashes = [...new Set(hashes)];

        return uniqueHashes;
    } catch (err) {
        console.error(
            `Could not retrieve '<${tagName}>' from ${inputFilePath}`
        );
        throw err;
    }
}

function addHashesToHtmlFile(inputFilePath, hashes) {
    // Add the hashes to the file's Content Security tag

    const template = "script-src &#x27;self&#x27;";

    // Read the file
    let fileContents = fs.readFileSync(inputFilePath, { encoding: "utf-8" });

    const newHashes = hashes.join(" ");
    //console.log(newHashes)
    // Replace the existing CSP tag with the new one
    const newCsp = `script-src 'self' ${newHashes}`;

    // Replace the CSP tag
    fileContents = fileContents.replace(template, newCsp);

    //console.log(fileContents.slice(0, 1000)); // Just to check the changes before writing the file

    //return

    // Write the file back
    fs.writeFileSync(inputFilePath, fileContents, { encoding: "utf-8" });
}

console.log("Done!");
