// Builds the web page twice from src/app.html:
//  public/index.html  - served by the Node server (loads /shared.js)
//  dist/artifact.html - standalone demo with the engine inlined (published as a Claude artifact)
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "src/app.html"), "utf8");
const shared = fs.readFileSync(path.join(root, "shared.js"), "utf8");
const head = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n';
fs.mkdirSync(path.join(root, "public"), { recursive: true });
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "public/index.html"), head + app.replace("<!--SHARED-->", '<script src="shared.js"></script>') + "\n</body></html>\n");
fs.writeFileSync(path.join(root, "dist/artifact.html"), app.replace("<!--SHARED-->", "<script>\n" + shared + "\n</script>"));
console.log("built public/index.html and dist/artifact.html");
