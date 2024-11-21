import frontmatter from "front-matter";
import fs from "fs-extra";
import klaw from "klaw";
import path from "path";
import rehypeDocument from "rehype-document";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import remarkWikiLink from "remark-wiki-link-plus";
import rehypeRaw from "rehype-raw";
import {read, write} from "to-vfile";
import {unified} from "unified";
import {is} from "unist-util-is";
import {reporter} from "vfile-reporter";
import {visit} from "unist-util-visit";

main();

function renameDirectoriesToLowercase(dirPath) {
    const ignoreDirs = ['.git', '.github', 'fonts'];
    // Read all items in the current directory
    const items = fs.readdirSync(dirPath);

    // Iterate over each item in the directory
    items.forEach(item => {
        const fullPath = path.join(dirPath, item);

        // Check if the item is a directory
        if (fs.statSync(fullPath).isDirectory()) {
            if (ignoreDirs.includes(item)) {
                return; // Skip this directory
            }
            // Get the lowercase version of the directory name
            const lowerCaseName = item.toLowerCase();

            // Determine the new path after renaming
            const newFullPath = path.join(dirPath, lowerCaseName);

            // Rename the directory if the name is different
            if (fullPath !== newFullPath) {
                try {
                    fs.renameSync(fullPath, newFullPath);
                } catch (e)
                {
                    console.error("Error: "+e+"\n this might happen, when directories have the same name when renamed to lower case")
                }

            }

            // Recursively process the renamed directory
            console.log("./" + newFullPath)
            renameDirectoriesToLowercase("./" + newFullPath);
        }
    });
}

async function main() {

    for await (const file of klaw("./notes")) {
        if (path.extname(file.path) === ".md") {
            const markdownVFile = await read(file.path);
            await compileAndWrite(markdownVFile);
        } else {
            if (!file.stats.isDirectory() && !file.path.includes(".obsidian")) {
                await copy(file.path, notesToOutPath(file.path));
            }
        }
    }

    await copy("node_modules/katex/dist/katex.min.css", "out/katex.min.css");
    await copy("node_modules/katex/dist/fonts", "out/fonts");
    await copy(
        "node_modules/highlight.js/styles/default.css",
        "out/highlight.css"
    );
    await renameDirectoriesToLowercase("./out");
}

async function compileAndWrite(markdownVFile) {
    const htmlVFile = await compile(markdownVFile);

    htmlVFile.dirname = notesToOutPath(markdownVFile.dirname);
    htmlVFile.extname = ".html";
    htmlVFile.stem = pageResolver(markdownVFile.stem);

    await fs.mkdir(htmlVFile.dirname, {recursive: true});
    await write(htmlVFile);
    console.log(`wrote ${htmlVFile.path}`);
}

async function compile(file) {
    const fm = frontmatter(file.value.toString());
    file.value = fm.body;

    // Relative path to root, needed to handle the root being user.github.io/project
    // notes/a/b.md => depth = 1, notes/a.md => depth = 0
    // if path is a Windows path, replace backslashes with forward slashes
    if (file.path.includes("\\")) {
        file.path = file.path.replace(/\\/g, "/");
    }
    let depth = file.path.split("/");
    depth = depth.reverse();
    depth = depth.lastIndexOf("notes") - 1;
    const root = "../".repeat(depth);

    return await unified()
        .use(remarkParse)
        .use(remarkRunCode) // NOTE: it's important this comes first
        .use(remarkWikiLink, {
            markdownFolder: "notes",
            hrefTemplate: (permalink) => permalink,
        })
        .use(remarkMath)
        .use(remarkNoInlineDoubleDollar)
        .use(remarkRehype, {allowDangerousHtml: true})
        .use(rehypeRaw)
        .use(rehypeHighlight)
        .use(rehypeKatex)
        .use(rehypeDocument, {
            title: fm.attributes.title || file.stem,
            css: [
                root + "styles.css",
                root + "highlight.css",
                root + "katex.min.css",
            ],
        })
        .use(rehypeStringify)
        .process(file)
        .then((file) => {
            if (file.messages.length > 0)
                console.error(reporter(file, {quiet: true}));
            file = fixWrongUrls(file);
            return file;
        });
}

function fixWrongUrls(html) {
    let text = html.value;
    const allALinks = extractLinks(text);
    const fixedALinks = replacedLinksFix(allALinks, "href");
    //Replace original html value with modified one
    fixedALinks.forEach(link => {
        if (link[1] !== undefined) {
            text = text.replace(link[0], link[1]);
        }
    })
    html.value = text

    const allImgLinks = extractImagesLinks(text);
    const fixedImgLinks = replacedLinksFix(allImgLinks, "src");
    fixedImgLinks.forEach(link => {
        if (link[1] !== undefined) {
            text = text.replace(link[0], link[1]);
        }
    })
    return html;
}

function extractImagesLinks(htmlValue) {
    const regex = /<img [^>]*>/g;
    return Array.from(htmlValue.matchAll(regex));
}

function extractUrlFromLink(link, attribute) {
    // Regular expression to extract link from a tag
    const linkRegex = new RegExp(`(?<=${attribute}=")[^"]*(?=")`, "g");
    return Array.from(link[0].matchAll(linkRegex));
}

function replacedLinksFix(originalLinks, attribute) {
    const fixedLinks = [];
    originalLinks.forEach((link) => {
        const urlFromLink = extractUrlFromLink(link,attribute);
        if (urlFromLink) {
            // If link is not local link and if is in sub dir
            if (!urlFromLink[0][0].startsWith("http") &&
                (urlFromLink[0][0].includes("/") || urlFromLink[0][0].includes("\\"))) {
                const dir = urlFromLink[0][0].split("/");
                if (dir.length > 1) {
                    //Scan every sub dir in url without file name
                    const parts = replaceCharsInDirectory(dir);
                    let fixedLink = fixUrlByParts(link, parts)
                    fixedLinks.push([link[0], fixedLink]);
                }
            }

        }
    });
    return fixedLinks;
}

function replaceCharsInDirectory(dir) {
    const parts = [];
    for (let i = 0; i < dir.length - 1; i++) {
        let fixedPart;

        //Fix white spaces and big letters
        if (dir[i].includes("-")) {
            //Replace "-" with " "
            const part = dir[i];
            fixedPart = dir[i].replaceAll("-", " ")

            parts.push([part, fixedPart])
        }

    }
    parts.push(dir.length-1)
    return parts;
}

function fixUrlByParts(link, parts) {
    let fixedLink
    for (let i = 0; i < parts.length; i++) {
        if (fixedLink === undefined) {
            fixedLink = link[0].replace(parts[i][0], parts[i][1])
        } else {
            fixedLink = fixedLink.replace(parts[i][0], parts[i][1])
        }
    }
    return fixedLink
}

function extractLinks(htmlValue) {
    // Regular expression to a html tags
    const regex = /<a [^>]*>/g;
    return Array.from(htmlValue.matchAll(regex));
}

function remarkRunCode() {
    return async (tree, file) => {
        // No recursion needed since code blocks are always at the top level
        for (const index in tree.children) {
            const node = tree.children[index];
            if (is(node, "code") && node.meta === "run") {
                try {
                    const module = await importInline(node.value);
                    const generatedTree = unified()
                        .use(remarkParse)
                        .parse(module.markdown);
                    tree.children.splice(index, 1, ...generatedTree.children);
                } catch (e) {
                    const message = file.message(`In code block: ${e}`, node);
                    message.fatal = true;
                }
            }
        }
    };
}

let cacheBusts = 0;

async function importInline(code) {
    // could use ?q cache busting, but then I have to worry about race conditions
    let file = `./.tmp${++cacheBusts}.js`;
    let module;
    try {
        await fs.writeFile(file, code);
        module = await import(file);
    } finally {
        await fs.remove(file);
    }
    return module;
}

// See https://github.com/UlisseMini/oth/issues/13
function remarkNoInlineDoubleDollar() {
    return (tree, file) => {
        visit(tree, "inlineMath", (node) => {
            const start = node.position.start.offset;
            const end = node.position.end.offset;
            const lexeme = file.value.slice(start, end);

            if (lexeme.startsWith("$$")) {
                file.message(
                    "$$math$$ renders inline in remark-math but display in obsidian. Did you forget newlines?",
                    node
                );
            }
        });
    };
}

// convert "Hello World" -> hello-world
const pageResolver = (name) => name.toLowerCase().replace(/ /g, "-");

// convert a/b/notes/c/d -> a/b/out/c/d
const notesToOutPath = (p) => path.join("out", path.relative("notes", p));

async function copy(src, dst) {
    await fs.copy(src, dst);
    console.log(`copied ${src} -> ${dst}`);
}
