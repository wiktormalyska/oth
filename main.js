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
import { read, write } from "to-vfile";
import { unified } from "unified";
import { is } from "unist-util-is";
import { reporter } from "vfile-reporter";
import { visit } from "unist-util-visit";
main();

async function* getAllDirectories(dir) {
  const files = await fs.readdir(dir, { withFileTypes: true });

  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory()) {
      yield fullPath;
      yield* getAllDirectories(fullPath); // Recursively yield subdirectories
    }
  }
}

async function renameDirectoriesToLowerCase(rootDir) {
  const directories = [];
  const ignoredDirectories = ['.git', 'node_modules', '.obsidian'];
  // Collect all directories
  for await (const dir of getAllDirectories(rootDir)) {
    var isIgnored = false;
    for(const ignoredDir of ignoredDirectories) {
        if (dir.includes(ignoredDir)) {
          isIgnored=true;
          break;
        }
    }
    isIgnored ? null : directories.push(dir);
  }

  // Sort directories by depth (deepest first)
  directories.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);

  // Rename directories
  for (const dirPath of directories) {
    const dirName = path.basename(dirPath);
    const lowerCaseDirName = dirName.toLowerCase();

    if (dirName !== lowerCaseDirName) {
      const newDirPath = path.join(path.dirname(dirPath), lowerCaseDirName);

      // Check if newDirPath already exists to avoid conflicts
      try {
        await fs.access(newDirPath);
        console.log(`Skipping renaming ${dirPath} as ${newDirPath} already exists.`);
      } catch {
        // If newDirPath doesn't exist, proceed with renaming
        try {
          await fs.rename(dirPath, newDirPath);
          console.log(`Renamed: ${dirPath} -> ${newDirPath}`);
        } catch (renameErr) {
          console.error(`Failed to rename ${dirPath} to ${newDirPath}:`, renameErr);
        }
      }
    }
  }
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
  await renameDirectoriesToLowerCase('./out').catch(err => {
    console.error('An error occurred during directory renaming:', err);
  });
}

async function compileAndWrite(markdownVFile) {
  const htmlVFile = await compile(markdownVFile);

  htmlVFile.dirname = notesToOutPath(markdownVFile.dirname);
  htmlVFile.extname = ".html";
  htmlVFile.stem = pageResolver(markdownVFile.stem);

  await fs.mkdir(htmlVFile.dirname, { recursive: true });
  await write(htmlVFile);
  console.log(`wrote ${htmlVFile.path}`);
}

async function compile(file) {
  const fm = frontmatter(file.value.toString());
  file.value = fm.body;

  // Relative path to root, needed to handle the root being user.github.io/project
  // notes/a/b.md => depth = 1, notes/a.md => depth = 0
  // if path is a Windows path, replace backslashes with forward slashes
  if (file.path.includes("\\"))
  {
    file.path = file.path.replace(/\\/g, "/");
  }
  var depth = file.path.split("/");
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
    .use(remarkRehype, { allowDangerousHtml: true })
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
        console.error(reporter(file, { quiet: true }));
      file = fixLinks(file);
      return file;
    });
}

function fixLinks(html) {
  var text = html.value;
  // Regular expression to a html tags
  const regex = /<a [^>]*>/g;
  var allLinks = Array.from(text.matchAll(regex));
  var fixedLinks = [];
  allLinks.forEach((link) => {
    // Regular expression to extract link from a tag
    const linkRegex = /(?<=href=")[^"]*(?=")/g
    const href = Array.from(link[0].matchAll(linkRegex));
    if (href) {
      // If link is not local link and if is in sub dir
      if (!href[0][0].startsWith("http") && href[0][0].includes("/")) {
        const dir = href[0][0].split("/");
        if(dir.length>1) {
          //Scan every sub dir in url without file name
          for(let i = 0; i < dir.length-1; i++) {
            var fixedPart
            var fixedLink
            //Fix white spaces and big letters
            if(dir[i].includes("-")) {
              //Replace "-" with " "
              fixedPart = dir[i].replaceAll("-", " ")
              fixedLink = link[0].replace(dir[0], fixedPart);
            }
            if(fixedLink == undefined) {
              continue
            }
            console.log(fixedLink)
            fixedLinks.push([link[0],fixedLink]);

          }
        }
      }

    }
  });
  //Replace original html value with modified one
  fixedLinks.forEach(link => {
    text = text.replaceAll(link[0], link[1]);
  })

  html.value = text
  return html;
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
